const crypto = require('node:crypto');

const { countMysqlRows, fetchMysqlRowsPageFromSession, openMysqlReadSession, closeMysqlReadSession, compareCursorValues } = require('./mysqlIntrospector');
const { truncatePostgresTable, writeRowsToPostgres, writeBatchedRowsToPostgres } = require('./postgresIntrospector');
const { transformRow } = require('./valueTransforms');
const { runWithConcurrency } = require('./async');

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function createExecutionEngine({ persistence }) {
  function chunkFingerprint(rows) {
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  function deterministicChunkId({ runId, tableName, cursor, rows }) {
    const cursorKey = JSON.stringify(cursor || {});
    const rowFingerprints = chunkFingerprint(rows || []);
    return crypto.createHash('sha256').update(`${runId}:${tableName}:${cursorKey}:${rowFingerprints}`).digest('hex');
  }

  async function markRun(runId, patch) {
    const existing = await persistence.getRun(runId);
    return persistence.saveRun({ ...existing, ...patch, updatedAt: new Date().toISOString() });
  }

  async function latestCheckpoint(runId, tableName) {
    const items = await persistence.listCheckpoints(runId);
    const filtered = items.filter((item) => item.tableName === tableName).sort((a, b) => Number(b.processed || 0) - Number(a.processed || 0));
    return filtered[0] || null;
  }

  function describeWriteMode(tableMapping) {
    const writeMode = tableMapping.writeMode || 'append';
    if (writeMode === 'truncate') {
      return {
        writeMode,
        label: 'truncate-load',
        guarantees: ['target table truncated once before load begins', 'resume is only safe if truncation happened within the same run context'],
        operatorNotes: ['prefer rerun from start if interruption happened after partial load'],
      };
    }
    if (writeMode === 'upsert') {
      return {
        writeMode,
        label: 'upsert',
        guarantees: ['writes are conflict-aware only when conflict keys are correct', 'replay risk is reduced when conflict keys map to stable unique keys'],
        operatorNotes: ['verify conflictKeys before execution', 'best mode for retry-friendly loads when natural keys exist'],
      };
    }
    return {
      writeMode,
      label: 'append',
      guarantees: ['rows are appended without deduplication guarantees'],
      operatorNotes: ['resume may duplicate writes unless target-side uniqueness prevents it'],
    };
  }

  function writeModeSafety(tableMapping) {
    const mode = tableMapping.writeMode || 'append';
    if (mode === 'upsert') {
      return {
        resumeSafety: (tableMapping.conflictKeys || []).length ? 'retry-friendly' : 'unsafe',
        duplicateRisk: 'low_when_conflict_keys_are_valid',
      };
    }
    if (mode === 'truncate') {
      return {
        resumeSafety: 'restart-preferred',
        duplicateRisk: 'medium',
      };
    }
    return {
      resumeSafety: 'best-effort',
      duplicateRisk: 'high',
    };
  }

  function normalizeLoadStrategy(tableMapping, options = {}, watermarks = {}) {
    const configured = tableMapping.loadStrategy || { mode: 'historical_full' };
    const tableWatermark = watermarks?.tables?.[tableMapping.sourceTable] || {};
    let phaseMode = configured.mode || 'historical_full';
    if (options.loadPhase === 'historical') {
      phaseMode = configured.mode === 'historical_filtered' || (configured.mode === 'historical_then_incremental' && configured.historicalFilter?.enabled) ? 'historical_filtered' : 'historical_full';
    } else if (options.loadPhase === 'incremental') {
      phaseMode = 'incremental_watermark';
    } else if (phaseMode === 'historical_then_incremental') {
      phaseMode = tableWatermark.lastWatermark != null ? 'incremental_watermark' : (configured.historicalFilter?.enabled ? 'historical_filtered' : 'historical_full');
    }

    return {
      ...configured,
      effectiveMode: phaseMode,
      tableWatermark,
      watermarkColumn: configured.watermarkColumn || tableMapping.watermarkColumn || options.watermarkColumn || tableWatermark.watermarkColumn || null,
      tieBreakerColumn: configured.tieBreakerColumn || tableWatermark.tieBreakerColumn || null,
      sourceFilter: phaseMode === 'historical_filtered' && configured.historicalFilter?.enabled ? configured.historicalFilter : null,
      persistWatermark: configured.persistWatermark !== false,
    };
  }

  async function loadProjectWatermarks(project) {
    if (typeof persistence.getWatermarks !== 'function') return { projectId: project.id, tables: {} };
    return (await persistence.getWatermarks(project.id)) || { projectId: project.id, tables: {} };
  }

  function applyLookback(value, strategy) {
    const amount = Number(strategy.lookbackAmount || 0);
    if (!amount || value == null) return value;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const unit = strategy.lookbackUnit || 'minutes';
    const multiplier = unit === 'days' ? 86400000 : unit === 'hours' ? 3600000 : 60000;
    return new Date(date.getTime() - amount * multiplier).toISOString();
  }

  function updateWatermarkFromRows({ rows, watermarkColumn, tieBreakerColumn, highWatermark, highWatermarkTieBreaker }) {
    if (!watermarkColumn) return { highWatermark, highWatermarkTieBreaker };
    let nextWatermark = highWatermark ?? null;
    let nextTieBreaker = highWatermarkTieBreaker ?? null;
    for (const row of rows || []) {
      const candidateWatermark = row?.[watermarkColumn] ?? null;
      const candidateTieBreaker = tieBreakerColumn ? (row?.[tieBreakerColumn] ?? null) : null;
      const watermarkComparison = compareCursorValues(candidateWatermark, nextWatermark);
      if (watermarkComparison > 0 || (watermarkComparison === 0 && compareCursorValues(candidateTieBreaker, nextTieBreaker) > 0)) {
        nextWatermark = candidateWatermark;
        nextTieBreaker = candidateTieBreaker;
      }
    }
    return { highWatermark: nextWatermark, highWatermarkTieBreaker: nextTieBreaker };
  }

  function detectResumeStrategy(project, tableMapping) {
    const sourceTable = (project.sourceCatalog?.tables || []).find((table) => table.name === tableMapping.sourceTable);
    const primaryKeyColumns = sourceTable?.primaryKey || [];
    if (primaryKeyColumns.length === 1) {
      return { mode: 'keyset', column: primaryKeyColumns[0] };
    }
    return { mode: 'offset' };
  }

  async function saveError(runId, tableName, error, context = {}) {
    return persistence.saveError({
      id: makeId('error'),
      runId,
      tableName,
      message: error?.message || String(error),
      context,
      rowPayload: context?.row || null,
      createdAt: new Date().toISOString(),
    });
  }

  function buildExecutionPlan(project, options = {}) {
    const selected = options.mode === 'selected' ? new Set(options.selectedTables || []) : null;
    const sourceTables = new Map((project.sourceCatalog?.tables || []).map((table) => [table.name, table]));
    const eligible = (project.tableMappings || []).filter((table) => table.enabled !== false && (!selected || selected.has(table.sourceTable)));

    const mappingBySource = new Map(eligible.map((table) => [table.sourceTable, table]));
    const baseIncomingCount = new Map();
    const outgoing = new Map();
    for (const mapping of eligible) {
      baseIncomingCount.set(mapping.sourceTable, 0);
      outgoing.set(mapping.sourceTable, new Set());
    }

    for (const mapping of eligible) {
      const sourceTable = sourceTables.get(mapping.sourceTable);
      for (const fk of sourceTable?.foreignKeys || []) {
        const parent = fk.referencedTable;
        if (!mappingBySource.has(parent)) continue;
        if (parent === mapping.sourceTable) continue;
        if (!outgoing.get(parent).has(mapping.sourceTable)) {
          outgoing.get(parent).add(mapping.sourceTable);
          baseIncomingCount.set(mapping.sourceTable, (baseIncomingCount.get(mapping.sourceTable) || 0) + 1);
        }
      }
    }

    const orderIncomingCount = new Map(baseIncomingCount);
    const queue = eligible
      .filter((mapping) => (orderIncomingCount.get(mapping.sourceTable) || 0) === 0)
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

    const ordered = [];
    while (queue.length) {
      const next = queue.shift();
      ordered.push(next);
      for (const child of Array.from(outgoing.get(next.sourceTable) || [])) {
        orderIncomingCount.set(child, (orderIncomingCount.get(child) || 1) - 1);
        if ((orderIncomingCount.get(child) || 0) === 0) {
          queue.push(mappingBySource.get(child));
          queue.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
        }
      }
    }

    const remaining = eligible.filter((mapping) => !ordered.some((item) => item.sourceTable === mapping.sourceTable));
    const orderedMappings = [...ordered, ...remaining.sort((a, b) => Number(a.order || 0) - Number(b.order || 0))];

    const layers = [];
    const processedNames = new Set();
    const layerIncomingCount = new Map(baseIncomingCount);
    while (processedNames.size < orderedMappings.length) {
      const layer = orderedMappings.filter((mapping) => !processedNames.has(mapping.sourceTable) && (layerIncomingCount.get(mapping.sourceTable) || 0) === 0);
      if (!layer.length) break;
      layers.push(layer.map((mapping) => mapping.sourceTable));
      for (const mapping of layer) {
        processedNames.add(mapping.sourceTable);
        for (const child of Array.from(outgoing.get(mapping.sourceTable) || [])) {
          layerIncomingCount.set(child, Math.max(0, (layerIncomingCount.get(child) || 0) - 1));
        }
      }
    }

    return {
      orderedMappings,
      layers,
      cyclesDetected: remaining.map((item) => item.sourceTable),
      steps: orderedMappings.map((mapping, index) => ({
        order: index + 1,
        sourceTable: mapping.sourceTable,
        targetTable: mapping.targetTable,
        writeMode: mapping.writeMode,
        conflictKeys: mapping.conflictKeys || [],
        dependsOn: Array.from((sourceTables.get(mapping.sourceTable)?.foreignKeys || []).map((fk) => fk.referencedTable).filter((name) => mappingBySource.has(name) && name !== mapping.sourceTable)),
      })),
    };
  }

  async function writeChunk({ runId, project, tableMapping, sourceRows, publish, options }) {
    const transformed = [];
    const rejected = [];

    for (let index = 0; index < sourceRows.length; index += 1) {
      const row = sourceRows[index];
      try {
        const transformedRow = transformRow({ row, tableMapping });
        if (transformedRow == null) continue;
        transformed.push(transformedRow);
      } catch (error) {
        rejected.push({ index, row, error });
      }
    }

    if (rejected.length && options.errorPolicy === 'fail-fast') {
      const failure = rejected[0];
      throw Object.assign(new Error(`Transform failed for ${tableMapping.sourceTable}: ${failure.error.message}`), { cause: failure.error });
    }

    for (const rejectedRow of rejected) {
      await saveError(runId, tableMapping.sourceTable, rejectedRow.error, { phase: 'transform', row: rejectedRow.row });
      publish('log', { level: 'warn', message: `Rejected row during transform for ${tableMapping.sourceTable}: ${rejectedRow.error.message}` });
    }

    if (!transformed.length) return { inserted: 0, rejected: rejected.length };

    try {
      const writer = options.batchSize && Number(options.batchSize) > 0 ? writeBatchedRowsToPostgres : writeRowsToPostgres;
      const result = await writer(project.runtimeTargetConnection || project.targetConnection, {
        schema: project.targetSchema,
        tableName: tableMapping.targetTable,
        rows: transformed,
        mode: tableMapping.writeMode === 'upsert' ? 'upsert' : 'append',
        conflictKeys: tableMapping.conflictKeys || [],
        batchSize: options.batchSize,
      });
      return { inserted: result.rowCount ?? transformed.length, rejected: rejected.length };
    } catch (error) {
      if (options.errorPolicy === 'fail-fast') throw error;
      let inserted = 0;
      for (const row of transformed) {
        try {
          const result = await writeRowsToPostgres(project.runtimeTargetConnection || project.targetConnection, {
            schema: project.targetSchema,
            tableName: tableMapping.targetTable,
            rows: [row],
            mode: tableMapping.writeMode === 'upsert' ? 'upsert' : 'append',
            conflictKeys: tableMapping.conflictKeys || [],
          });
          inserted += result.rowCount ?? 1;
        } catch (singleError) {
          await saveError(runId, tableMapping.sourceTable, singleError, { phase: 'write', row });
          publish('log', { level: 'warn', message: `Rejected row during write for ${tableMapping.sourceTable}: ${singleError.message}` });
        }
      }
      return { inserted, rejected: rejected.length + (transformed.length - inserted) };
    }
  }

  async function executeTable({ runId, tableMapping, publish, project, options }) {
    if (!tableMapping.targetTable) throw new Error(`Missing target table for source table ${tableMapping.sourceTable}`);
    const enabledMappings = (tableMapping.columnMappings || []).filter((column) => column.enabled !== false && column.targetColumnMode !== 'ignore' && column.targetColumn);
    if (!enabledMappings.length) throw new Error(`No enabled mapped columns for source table ${tableMapping.sourceTable}`);

    const projectWatermarks = options.projectWatermarks || {};
    const loadStrategy = normalizeLoadStrategy(tableMapping, options, projectWatermarks);
    const isIncremental = loadStrategy.effectiveMode === 'incremental_watermark';
    publish('log', { level: 'info', message: `Processing table ${tableMapping.sourceTable} -> ${tableMapping.targetTable} (${loadStrategy.effectiveMode})` });
    const chunkSize = Math.max(1, Number(tableMapping.chunkSize || 500));
    const startedAtMs = Date.now();
    const checkpoint = await latestCheckpoint(runId, tableMapping.sourceTable);
    const resumeStrategy = detectResumeStrategy(project, tableMapping);
    let offset = isIncremental ? 0 : Number(checkpoint?.offset || 0);
    let inserted = Number(checkpoint?.rowsInserted || 0);
    let rejected = Number(checkpoint?.rowsRejected || 0);
    let truncated = Boolean(checkpoint?.truncated);
    let lastValue = isIncremental ? null : (checkpoint?.keyset?.lastValue ?? null);
    let lastChunkFingerprint = checkpoint?.lastChunkFingerprint || null;
    let lastChunkId = checkpoint?.lastChunkId || null;
    const watermarkColumn = loadStrategy.watermarkColumn;
    const tieBreakerColumn = watermarkColumn ? (loadStrategy.tieBreakerColumn || (resumeStrategy.mode === 'keyset' ? resumeStrategy.column : ((project.sourceCatalog?.tables || []).find((table) => table.name === tableMapping.sourceTable)?.primaryKey || [])[0] || null)) : null;
    let highWatermark = isIncremental
      ? applyLookback(loadStrategy.tableWatermark?.lastWatermark ?? loadStrategy.baselineWatermark ?? null, loadStrategy)
      : (checkpoint?.highWatermark ?? loadStrategy.baselineWatermark ?? null);
    let highWatermarkTieBreaker = isIncremental
      ? (loadStrategy.tableWatermark?.lastTieBreaker ?? loadStrategy.baselineTieBreaker ?? null)
      : (checkpoint?.highWatermarkTieBreaker ?? loadStrategy.baselineTieBreaker ?? null);

    if (isIncremental && !watermarkColumn) {
      throw new Error(`Watermark mode requires a watermark column for source table ${tableMapping.sourceTable}`);
    }
    if (isIncremental && !tieBreakerColumn) {
      throw new Error(`Watermark mode requires a stable tie-breaker column for source table ${tableMapping.sourceTable}`);
    }

    const initialCountKeyset = isIncremental && watermarkColumn
      ? { watermarkColumn, watermarkValue: highWatermark, tieBreakerColumn, tieBreakerValue: highWatermarkTieBreaker }
      : undefined;
    const totalRows = await countMysqlRows(project.runtimeSourceConnection || project.sourceConnection, project.sourceSchema, tableMapping.sourceTable, { sourceFilter: loadStrategy.sourceFilter, keyset: initialCountKeyset });

    const sourceSession = await openMysqlReadSession(project.runtimeSourceConnection || project.sourceConnection, { database: project.sourceSchema });
    publish('log', { level: 'info', message: `Source read consistency for ${tableMapping.sourceTable}: ${sourceSession.consistencyMode}` });

    try {
      if (tableMapping.writeMode === 'truncate' && !truncated && !options.dryRun) {
        publish('log', { level: 'info', message: `Truncating target table ${project.targetSchema}.${tableMapping.targetTable}` });
        await truncatePostgresTable(project.runtimeTargetConnection || project.targetConnection, project.targetSchema, tableMapping.targetTable);
        truncated = true;
      }

      while (offset < totalRows) {
        const fetchColumns = Array.from(new Set([
          ...enabledMappings.map((column) => column.sourceColumn),
          ...(resumeStrategy.mode === 'keyset' ? [resumeStrategy.column] : []),
          ...(watermarkColumn ? [watermarkColumn] : []),
          ...(tieBreakerColumn ? [tieBreakerColumn] : []),
        ]));
        const keyset = isIncremental && watermarkColumn
          ? { watermarkColumn, watermarkValue: highWatermark, tieBreakerColumn, tieBreakerValue: highWatermarkTieBreaker }
          : (resumeStrategy.mode === 'keyset' ? { column: resumeStrategy.column, lastValue } : undefined);
        const rows = await fetchMysqlRowsPageFromSession(sourceSession, project.sourceSchema, tableMapping.sourceTable, {
          columns: fetchColumns,
          limit: chunkSize,
          offset: resumeStrategy.mode === 'offset' ? offset : 0,
          keyset,
          sourceFilter: loadStrategy.sourceFilter,
        });
        if (!rows.length) break;

        const currentChunkFingerprint = chunkFingerprint(rows);
        const currentChunkId = deterministicChunkId({
          runId,
          tableName: tableMapping.sourceTable,
          cursor: {
            offset,
            lastValue,
            watermarkColumn,
            highWatermark,
            tieBreakerColumn,
            highWatermarkTieBreaker,
          },
          rows,
        });
        const duplicateChunk = Boolean(
          (lastChunkId && lastChunkId === currentChunkId)
          || (lastChunkFingerprint && lastChunkFingerprint === currentChunkFingerprint && checkpoint?.offset === offset),
        );

        if (duplicateChunk) {
          publish('log', { level: 'warn', message: `Skipping duplicate chunk for ${tableMapping.sourceTable} at offset ${offset}` });
          offset += rows.length;
          if (resumeStrategy.mode === 'keyset') {
            lastValue = rows[rows.length - 1]?.[resumeStrategy.column] ?? lastValue;
          }
          continue;
        }

        let outcome = { inserted: rows.length, rejected: 0 };
        if (!options.dryRun) {
          outcome = await writeChunk({ runId, project, tableMapping, sourceRows: rows, publish, options });
        }
        inserted += outcome.inserted;
        rejected += outcome.rejected;
        offset += rows.length;
        if (resumeStrategy.mode === 'keyset') {
          lastValue = rows[rows.length - 1]?.[resumeStrategy.column] ?? lastValue;
        }
        ({ highWatermark, highWatermarkTieBreaker } = updateWatermarkFromRows({ rows, watermarkColumn, tieBreakerColumn, highWatermark, highWatermarkTieBreaker }));
        lastChunkFingerprint = currentChunkFingerprint;
        lastChunkId = currentChunkId;

        await persistence.saveCheckpoint({
          id: `${runId}_${tableMapping.sourceTable}_${offset}`,
          runId,
          tableName: tableMapping.sourceTable,
          processed: offset,
          offset,
          rowsInserted: inserted,
          rowsRejected: rejected,
          truncated,
          resumeStrategy,
          consistencyMode: sourceSession.consistencyMode,
          writeMode: tableMapping.writeMode || 'append',
          writeModeSafety: writeModeSafety(tableMapping),
          keyset: resumeStrategy.mode === 'keyset' ? { column: resumeStrategy.column, lastValue } : null,
          highWatermark,
          highWatermarkTieBreaker,
          lastChunkFingerprint,
          lastChunkId,
          createdAt: new Date().toISOString(),
        });

        publish('progress', {
          scope: 'table',
          table: tableMapping.sourceTable,
          processed: offset,
          total: totalRows,
          batch: rows.length,
          inserted,
          rejected,
        });
      }
    } finally {
      await closeMysqlReadSession(sourceSession);
    }

    if (!options.dryRun && loadStrategy.persistWatermark && watermarkColumn && highWatermark != null && typeof persistence.updateTableWatermark === 'function') {
      await persistence.updateTableWatermark(project.id, tableMapping.sourceTable, {
        watermarkColumn,
        tieBreakerColumn,
        lastWatermark: highWatermark,
        lastTieBreaker: highWatermarkTieBreaker,
        loadStrategy: loadStrategy.effectiveMode,
        sourceFilter: loadStrategy.sourceFilter || null,
        runId,
      });
    }

    return {
      tableName: tableMapping.sourceTable,
      targetTable: tableMapping.targetTable,
      status: rejected > 0 ? 'partial' : 'done',
      processed: offset,
      totalRows,
      inserted,
      rejected,
      resumeStrategy,
      consistencyMode: sourceSession.consistencyMode,
      highWatermark,
      highWatermarkTieBreaker,
      loadStrategy: loadStrategy.effectiveMode,
      throughputRowsPerSecond: Number((((inserted + rejected) || 0) / Math.max(1, (Date.now() - startedAtMs) / 1000)).toFixed(2)),
      checkpointSafety: writeModeSafety(tableMapping),
      writeDisposition: describeWriteMode(tableMapping),
    };
  }

  async function executeRun({ runId, project, options, publish }) {
    await markRun(runId, { status: 'running' });
    const projectWatermarks = await loadProjectWatermarks(project);
    options.projectWatermarks = projectWatermarks;
    const plan = buildExecutionPlan(project, options);
    const tables = plan.orderedMappings;
    const tableStatuses = [];
    let totalInserted = 0;
    let totalRejected = 0;
    const executionProfile = {
      mode: options.mode,
      dryRun: Boolean(options.dryRun),
      errorPolicy: options.errorPolicy,
      selectedTables: options.selectedTables || [],
      concurrency: Math.max(1, Number(options.concurrency) || 1),
      batchSize: Math.max(1, Number(options.batchSize) || 1000),
      cdcMode: options.cdcMode || 'off',
      cutoverMode: options.cutoverMode || 'manual',
      scheduler: 'dependency-layered',
      consistentRead: project.runtimeSourceConnection?.consistentRead || project.sourceConnection?.consistentRead || { enabled: false },
      consistencyMode: project.runtimeSourceConnection?.consistentRead?.enabled || project.sourceConnection?.consistentRead?.enabled ? 'table-snapshot' : 'best-effort',
      tableWriteModes: tables.map((table) => ({ sourceTable: table.sourceTable, targetTable: table.targetTable, ...describeWriteMode(table) })),
      layers: plan.layers || [],
      verificationFingerprint: options.verificationFingerprint || null,
    };
    publish('log', { level: 'info', message: `Execution plan prepared for ${tables.length} table(s)` });
    publish('log', {
      level: 'info',
      message: `Run mode=${options.mode}; errorPolicy=${options.errorPolicy}; dryRun=${Boolean(options.dryRun)}; selected=${(options.selectedTables || []).join(',') || 'all'}`,
    });
    if (plan.cyclesDetected.length) {
      publish('log', { level: 'warn', message: `Dependency cycle or unresolved order detected for: ${plan.cyclesDetected.join(', ')}` });
    }
    const processTable = async (table) => {
      try {
        const status = await executeTable({ runId, tableMapping: table, publish, project, options });
        return { status };
      } catch (error) {
        await saveError(runId, table.sourceTable, error, { phase: 'table' });
        publish('log', { level: 'error', message: error.message || String(error) });
        return { status: { tableName: table.sourceTable, targetTable: table.targetTable, status: 'error', error: error.message || String(error) }, error };
      }
    };

    const layeredMappings = (plan.layers || []).map((layer) => layer.map((name) => tables.find((table) => table.sourceTable === name)).filter(Boolean));
    const fallbackLayer = tables.filter((table) => !(plan.layers || []).flat().includes(table.sourceTable));
    if (fallbackLayer.length) layeredMappings.push(fallbackLayer);

    for (const layer of layeredMappings) {
      const processed = await runWithConcurrency(layer, processTable, { concurrency: executionProfile.concurrency });
      for (const item of processed) {
        const status = item.status;
        totalInserted += status.inserted || 0;
        totalRejected += status.rejected || 0;
        tableStatuses.push(status);
        if (item.error && options.errorPolicy === 'fail-fast') {
          await markRun(runId, {
            status: 'error',
            counters: { rowsInserted: totalInserted, rowsRejected: totalRejected, tablesCompleted: tableStatuses.filter((entry) => entry.status !== 'error').length, totalTables: tables.length },
            tableStatuses,
          });
          throw item.error;
        }
        await markRun(runId, {
          status: 'running',
          counters: { rowsInserted: totalInserted, rowsRejected: totalRejected, tablesCompleted: tableStatuses.length, totalTables: tables.length },
          tableStatuses,
        });
        publish('progress', {
          scope: 'run',
          completedTables: tableStatuses.length,
          totalTables: tables.length,
          rowsInserted: totalInserted,
          rowsRejected: totalRejected,
        });
      }
    }
    const hasErrors = tableStatuses.some((item) => item.status === 'error');
    await markRun(runId, {
      status: hasErrors ? 'partial' : (options.dryRun ? 'previewed' : 'done'),
      counters: { rowsInserted: totalInserted, rowsRejected: totalRejected, tablesCompleted: tableStatuses.length, totalTables: tables.length },
      tableStatuses,
      executionProfile,
    });
  }

  async function resumeRun({ runId, project, publish }) {
    const run = await persistence.getRun(runId);
    if (!run) throw new Error('Run not found');
    const originalOptions = {
      mode: run.executionProfile?.mode || run.mode || 'all',
      selectedTables: run.executionProfile?.selectedTables || run.selectedTables || [],
      dryRun: Boolean(run.executionProfile?.dryRun ?? run.dryRun),
      errorPolicy: run.executionProfile?.errorPolicy || run.errorPolicy || 'fail-fast',
      concurrency: run.executionProfile?.concurrency || 1,
      batchSize: run.executionProfile?.batchSize || 1000,
      cdcMode: run.executionProfile?.cdcMode || 'off',
      loadPhase: run.executionProfile?.loadPhase || 'configured',
      cutoverMode: run.executionProfile?.cutoverMode || 'manual',
      watermarkColumn: run.executionProfile?.watermarkColumn || null,
      verificationFingerprint: run.executionProfile?.verificationFingerprint || null,
    };
    if (originalOptions.dryRun) {
      throw new Error('Dry-run/preview runs cannot be resumed into real writes. Start a new execution run instead.');
    }
    originalOptions.projectWatermarks = await loadProjectWatermarks(project);
    const completed = new Set((run.tableStatuses || []).filter((table) => table.status === 'done' || table.status === 'partial').map((table) => table.tableName));
    const plan = buildExecutionPlan(project, originalOptions);
    const tables = plan.orderedMappings.filter((table) => !completed.has(table.sourceTable));
    let totalInserted = run.counters?.rowsInserted || 0;
    let totalRejected = run.counters?.rowsRejected || 0;
    const tableStatuses = [...(run.tableStatuses || [])];
    await markRun(runId, { status: 'running' });
    for (const table of tables) {
      const status = await executeTable({ runId, tableMapping: table, publish, project, options: originalOptions });
      totalInserted += status.inserted;
      totalRejected += status.rejected || 0;
      tableStatuses.push(status);
      await markRun(runId, {
        status: 'running',
        counters: { rowsInserted: totalInserted, rowsRejected: totalRejected, tablesCompleted: tableStatuses.length, totalTables: (project.tableMappings || []).length },
        tableStatuses,
      });
    }
    await markRun(runId, {
      status: 'done',
      counters: { rowsInserted: totalInserted, rowsRejected: totalRejected, tablesCompleted: tableStatuses.length, totalTables: (project.tableMappings || []).length },
      tableStatuses,
      executionProfile: run.executionProfile || originalOptions,
    });
  }

  return { executeRun, resumeRun, buildExecutionPlan };
}

module.exports = { createExecutionEngine };
