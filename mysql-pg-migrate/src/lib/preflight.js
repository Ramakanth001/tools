const { supportedTransformTypes, transformRow, validateTransformRule, shouldIncludeRow } = require('./valueTransforms');
const { buildRunAuditReport } = require('./reporting');
const { classifyTypeCompatibility: classifyTypeCompatibilityByCatalog } = require('./typeCompatibility');

function classifyTypeCompatibility(sourceColumn, targetColumn) {
  return classifyTypeCompatibilityByCatalog(sourceColumn, targetColumn);
}

function collectTargetRequirements(table) {
  return (table.columns || []).filter((column) => !column.nullable && !column.defaultValue && !column.generated && !column.identity);
}

function normalizeCompatibilityToState(compatibility) {
  if (!compatibility) return 'unknown';
  if (compatibility.status === 'compatible') return 'compatible';
  if (compatibility.status === 'compatible_with_transform') return 'transform_required';
  if (compatibility.status === 'risky') return 'risky';
  if (compatibility.status === 'incompatible') return 'blocked';
  if (compatibility.status === 'provisioned') return 'provisioned';
  return 'unknown';
}

function normalizeColumnMappingState({ sourceColumn, targetColumn, compatibility, mappingEnabled, transformType, schemaAction }) {
  if (mappingEnabled === false) return 'disabled';
  if (!sourceColumn) return 'missing_source';
  if (!targetColumn && schemaAction !== 'create_table' && schemaAction !== 'alter_table_add_columns') return 'unmapped';
  if (compatibility?.status === 'incompatible') return 'blocked';
  if (compatibility?.status === 'risky') return 'risky';
  if (compatibility?.status === 'compatible_with_transform') return 'transform_required';
  if (compatibility?.status === 'provisioned') return 'provisioned';
  if (!transformType || transformType === 'direct') return 'ready';
  return 'ready_with_transform';
}

function deriveTableCompleteness(columns = []) {
  const active = columns.filter((column) => column.mappingEnabled !== false);
  const blocked = active.filter((column) => ['blocked', 'missing_source', 'unmapped'].includes(column.columnState || column.state));
  if (blocked.length) return { level: 'blocked', counts: { total: active.length, blocked: blocked.length } };
  const review = active.filter((column) => ['risky', 'transform_required', 'ready_with_transform'].includes(column.columnState || column.state));
  if (review.length) return { level: 'review', counts: { total: active.length, review: review.length } };
  const provision = active.filter((column) => (column.columnState || column.state) === 'provisioned');
  if (provision.length) return { level: 'provision', counts: { total: active.length, provision: provision.length } };
  return { level: 'ready', counts: { total: active.length } };
}

function isColumnMappingActive(columnMapping) {
  if (!columnMapping) return false;
  if (columnMapping.enabled === false) return false;
  if (columnMapping.targetColumnMode === 'ignore') return false;
  return true;
}

function addDuplicateDiagnostics({ mappings, keyFn, kind, target, blockers, warnings, severity = 'blocker' }) {
  const seen = new Map();
  for (const mapping of mappings || []) {
    const key = keyFn(mapping);
    if (!key) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = Array.from(seen.entries()).filter(([, count]) => count > 1).map(([key]) => key);
  if (!duplicates.length) return;
  const item = { kind, target, duplicates };
  if (severity === 'warning') warnings.push(item);
  else blockers.push(item);
}

function normalizeLoadStrategy(mapping) {
  return mapping.loadStrategy || { mode: 'historical_full' };
}

function isIncrementalStrategy(strategy) {
  return ['incremental_watermark', 'historical_then_incremental'].includes(strategy?.mode || 'historical_full');
}

function validateHistoricalFilter({ strategy, sourceTable, tableBlockers, tableWarnings, tableName }) {
  if (strategy?.mode !== 'historical_filtered' && strategy?.mode !== 'historical_then_incremental') return;
  const filter = strategy?.historicalFilter;
  if (!filter?.enabled) {
    if (strategy?.mode === 'historical_filtered') {
      tableBlockers.push({ kind: 'missing_historical_filter', table: tableName, message: 'Historical filtered load requires a filter column/operator/value.' });
    }
    return;
  }
  const sourceColumnNames = new Set((sourceTable?.columns || []).map((column) => column.name));
  if (!filter.column || !sourceColumnNames.has(filter.column)) {
    tableBlockers.push({ kind: 'invalid_historical_filter_column', table: tableName, column: filter.column || null });
  }
  if (!['is_null', 'is_not_null'].includes(filter.operator) && (filter.value == null || filter.value === '')) {
    tableBlockers.push({ kind: 'missing_historical_filter_value', table: tableName, column: filter.column || null });
  }
  if (filter.operator === 'between' && (filter.valueTo == null || filter.valueTo === '')) {
    tableBlockers.push({ kind: 'missing_historical_filter_end_value', table: tableName, column: filter.column || null });
  }
  tableWarnings.push({ kind: 'historical_filter_review', table: tableName, message: 'Review filtered historical loads carefully before execution.' });
}

function validateIncrementalStrategy({ strategy, sourceTable, mapping, tableBlockers, tableWarnings }) {
  if (!isIncrementalStrategy(strategy)) return;
  const sourceColumnNames = new Set((sourceTable?.columns || []).map((column) => column.name));
  const watermarkColumn = strategy.watermarkColumn || mapping.watermarkColumn;
  const tieBreakerColumn = strategy.tieBreakerColumn || (sourceTable?.primaryKey || [])[0];

  if (!watermarkColumn || !sourceColumnNames.has(watermarkColumn)) {
    tableBlockers.push({ kind: 'missing_incremental_watermark_column', table: mapping.sourceTable, watermarkColumn: watermarkColumn || null, message: 'Incremental load requires a valid source watermark column.' });
  }
  if (!tieBreakerColumn || !sourceColumnNames.has(tieBreakerColumn)) {
    tableBlockers.push({ kind: 'missing_incremental_tie_breaker_column', table: mapping.sourceTable, tieBreakerColumn: tieBreakerColumn || null, message: 'Incremental load requires a stable tie-breaker column, preferably a primary key.' });
  }
  const watermarkMeta = (sourceTable?.columns || []).find((column) => column.name === watermarkColumn);
  if (watermarkMeta?.nullable) {
    tableWarnings.push({ kind: 'nullable_watermark_column', table: mapping.sourceTable, watermarkColumn, message: 'Nullable watermark columns can cause missed or unstable incremental reads.' });
  }
  if ((mapping.writeMode || 'append') !== 'upsert') {
    tableWarnings.push({ kind: 'incremental_without_upsert', table: mapping.sourceTable, message: 'Incremental loads that may update existing rows are safest with write mode upsert and valid conflict keys.' });
  }
  if (!(mapping.conflictKeys || []).length) {
    tableWarnings.push({ kind: 'incremental_without_conflict_keys', table: mapping.sourceTable, message: 'Without conflict keys, incremental replays/lookback can duplicate rows.' });
  }
  if (!Number(strategy.lookbackAmount || 0)) {
    tableWarnings.push({ kind: 'no_incremental_lookback_window', table: mapping.sourceTable, message: 'A small lookback window helps catch late-arriving updates.' });
  }
  if (strategy.deleteHandling?.mode !== 'soft_delete') {
    tableWarnings.push({ kind: 'incremental_hard_deletes_not_captured', table: mapping.sourceTable, message: 'Watermark incremental loads do not capture hard deletes. Use a soft-delete column or manual reconciliation.' });
  } else if (strategy.deleteHandling?.column && !sourceColumnNames.has(strategy.deleteHandling.column)) {
    tableBlockers.push({ kind: 'missing_soft_delete_column', table: mapping.sourceTable, column: strategy.deleteHandling.column });
  }
}

async function analyzePreflight({ project, sampleSourceRows, schemaPlan }) {
  const sourceTables = new Map((project.sourceCatalog.tables || []).map((table) => [table.name, table]));
  const targetTables = new Map((project.targetCatalog.tables || []).map((table) => [table.name, table]));
  const schemaPlanByTarget = new Map((schemaPlan?.tables || []).map((table) => [table.targetTable, table]));
  const tableReports = [];
  const blockers = [];
  const warnings = [];
  const activeTableMappings = (project.tableMappings || []).filter((mapping) => mapping.enabled !== false);

  if (!activeTableMappings.length) {
    blockers.push({ kind: 'no_enabled_table_mappings', message: 'At least one enabled table mapping is required before verification or execution.' });
  }

  addDuplicateDiagnostics({
    mappings: activeTableMappings,
    keyFn: (mapping) => mapping.sourceTable,
    kind: 'duplicate_source_table_mapping',
    target: 'project',
    blockers,
    warnings,
  });

  for (const mapping of project.tableMappings || []) {
    if (mapping.enabled === false) {
      tableReports.push({
        tableMappingId: mapping.id,
        sourceTable: mapping.sourceTable,
        targetTable: mapping.targetTable,
        blockers: [],
        warnings: [{ kind: 'table_mapping_disabled', table: mapping.sourceTable }],
        columns: [],
        completeness: { level: 'disabled', counts: { total: 0 } },
        readiness: { level: 'disabled', reasons: ['Table mapping is disabled'] },
        schemaAction: null,
      });
      continue;
    }

    const sourceTable = sourceTables.get(mapping.sourceTable);
    const targetTable = mapping.targetTable ? targetTables.get(mapping.targetTable) : null;
    const schemaEntry = schemaPlanByTarget.get(mapping.targetTable || mapping.sourceTable) || null;
    const targetColumns = new Map((targetTable?.columns || []).map((column) => [column.name, column]));
    const targetKeySets = [
      ...(targetTable?.primaryKey?.length ? [targetTable.primaryKey] : []),
      ...((targetTable?.uniqueKeys || []).map((key) => key.columns || [])),
    ].filter((key) => key.length);
    const tableBlockers = [];
    const tableWarnings = [];
    const targetWillBeCreated = mapping.createTargetTable === true || mapping.targetTableMode === 'create_new';
    const primaryKeyColumns = sourceTable?.primaryKey || [];
    const loadStrategy = normalizeLoadStrategy(mapping);
    if (!sourceTable) tableBlockers.push({ kind: 'missing_source_table', table: mapping.sourceTable || null });
    validateHistoricalFilter({ strategy: loadStrategy, sourceTable, tableBlockers, tableWarnings, tableName: mapping.sourceTable });
    validateIncrementalStrategy({ strategy: loadStrategy, sourceTable, mapping, tableBlockers, tableWarnings });
    if (targetWillBeCreated && !String(mapping.targetTable || '').trim()) tableBlockers.push({ kind: 'missing_new_target_table_name', table: mapping.sourceTable, message: 'Create-new target table mappings require a target table name' });
    if (!targetTable && !targetWillBeCreated) tableBlockers.push({ kind: 'missing_target_table', table: mapping.sourceTable, target: mapping.targetTable || null });
    if (!targetTable && targetWillBeCreated) tableWarnings.push({ kind: 'target_table_will_be_created', table: mapping.sourceTable, target: mapping.targetTable || mapping.sourceTable });
    if (mapping.writeMode === 'upsert' && !(mapping.conflictKeys || []).length) tableBlockers.push({ kind: 'missing_conflict_keys', table: mapping.sourceTable, target: mapping.targetTable || null });
    if (mapping.writeMode === 'append') tableWarnings.push({ kind: 'append_mode_duplicate_risk', table: mapping.sourceTable, message: 'append mode remains vulnerable to duplicate writes on retry/resume unless target-side uniqueness prevents it' });
    if (mapping.writeMode === 'truncate') tableWarnings.push({ kind: 'truncate_mode_restart_recommended', table: mapping.sourceTable, message: 'truncate mode is safest when rerun from start after interruption' });
    if (mapping.writeMode === 'upsert' && (mapping.conflictKeys || []).length) {
      const matchesKey = targetKeySets.some((key) => key.length === mapping.conflictKeys.length && key.every((column, index) => column === mapping.conflictKeys[index]));
      if (!matchesKey) {
        tableBlockers.push({ kind: 'invalid_conflict_keys', table: mapping.sourceTable, target: mapping.targetTable || null, conflictKeys: mapping.conflictKeys, message: 'configured conflict keys do not match a target primary key or unique key' });
      }
    }
    if (mapping.watermarkColumn) {
      const sourceColumnNames = new Set((sourceTable?.columns || []).map((column) => column.name));
      if (!sourceColumnNames.has(mapping.watermarkColumn)) {
        tableBlockers.push({ kind: 'missing_watermark_column', table: mapping.sourceTable, watermarkColumn: mapping.watermarkColumn, message: 'configured watermark column does not exist on source table' });
      }
      if (!primaryKeyColumns.length) {
        tableWarnings.push({ kind: 'watermark_without_primary_key', table: mapping.sourceTable, message: 'watermark mode works best with a stable primary key tie-breaker' });
      }
    }

    const activeColumnMappings = (mapping.columnMappings || []).filter(isColumnMappingActive);
    if (!activeColumnMappings.some((column) => column.targetColumn)) {
      tableBlockers.push({ kind: 'no_enabled_column_mappings', table: mapping.sourceTable, message: 'At least one enabled source column must map to a target column.' });
    }
    addDuplicateDiagnostics({
      mappings: activeColumnMappings,
      keyFn: (column) => column.sourceColumn,
      kind: 'duplicate_source_column_mapping',
      target: mapping.sourceTable,
      blockers: tableBlockers,
      warnings: tableWarnings,
    });
    addDuplicateDiagnostics({
      mappings: activeColumnMappings,
      keyFn: (column) => column.targetColumn,
      kind: 'duplicate_target_column_mapping',
      target: mapping.targetTable,
      blockers: tableBlockers,
      warnings: tableWarnings,
    });

    const mappedTargetColumns = new Set();
    const columnReports = [];
    let readiness = schemaEntry?.readiness?.level || 'ready';
    const readinessReasons = [...(schemaEntry?.readiness?.reasons || [])];

    for (const columnMapping of mapping.columnMappings || []) {
      const sourceColumn = (sourceTable?.columns || []).find((column) => column.name === columnMapping.sourceColumn);
      const targetColumn = columnMapping.targetColumn ? targetColumns.get(columnMapping.targetColumn) : null;
      const columnActive = isColumnMappingActive(columnMapping);

      if (!columnActive) {
        columnReports.push({
          sourceColumn: columnMapping.sourceColumn,
          targetColumn: columnMapping.targetColumn || null,
          compatibility: { status: 'disabled', message: columnMapping.targetColumnMode === 'ignore' ? 'ignored_by_mapping' : 'disabled_mapping' },
          state: 'disabled',
          columnState: 'disabled',
          mappingEnabled: false,
          transformType: columnMapping.transform?.type || 'direct',
        });
        continue;
      }

      if (!String(columnMapping.targetColumn || '').trim()) {
        tableBlockers.push({ kind: 'missing_target_column_mapping', sourceColumn: columnMapping.sourceColumn, message: 'Enabled column mappings require a target column or must be marked ignore.' });
      }

      if (columnMapping.targetColumnMode === 'create_new' && !String(columnMapping.targetColumn || '').trim()) {
        tableBlockers.push({ kind: 'missing_new_target_column_name', sourceColumn: columnMapping.sourceColumn });
      }

      if (!sourceColumn) {
        tableBlockers.push({ kind: 'missing_source_column', column: columnMapping.sourceColumn });
        columnReports.push({
          sourceColumn: columnMapping.sourceColumn,
          targetColumn: columnMapping.targetColumn || null,
          compatibility: { status: 'incompatible', message: 'missing_source_column' },
          state: 'missing_source',
          columnState: 'missing_source',
          mappingEnabled: columnMapping.enabled !== false,
          transformType: columnMapping.transform?.type || 'direct',
        });
        continue;
      }

      const targetColumnWillBeCreated = columnMapping.targetColumnMode === 'create_new' || targetWillBeCreated || schemaEntry?.action === 'alter_table_add_columns';
      if (!targetColumn && !targetColumnWillBeCreated) {
        tableBlockers.push({ kind: 'missing_target_column', column: columnMapping.targetColumn, sourceColumn: sourceColumn.name });
      }

      if (targetColumn) mappedTargetColumns.add(targetColumn.name);
      if (!supportedTransformTypes().includes(String(columnMapping.transform?.type || 'direct'))) {
        tableBlockers.push({ kind: 'unsupported_transform', sourceColumn: sourceColumn.name, targetColumn: targetColumn?.name || columnMapping.targetColumn, transform: columnMapping.transform?.type || 'direct' });
      }

      const compatibility = targetColumn ? classifyTypeCompatibility(sourceColumn, targetColumn) : { status: 'provisioned', message: 'target_column_will_be_created' };
      const state = normalizeCompatibilityToState(compatibility);
      const columnState = normalizeColumnMappingState({
        sourceColumn,
        targetColumn,
        compatibility,
        mappingEnabled: columnMapping.enabled !== false,
        transformType: columnMapping.transform?.type || 'direct',
        schemaAction: schemaEntry?.action,
      });

      columnReports.push({
        sourceColumn: sourceColumn.name,
        targetColumn: targetColumn ? targetColumn.name : (columnMapping.targetColumn || sourceColumn.name),
        compatibility,
        state,
        columnState,
        mappingEnabled: columnMapping.enabled !== false,
        transformType: columnMapping.transform?.type || 'direct',
      });

      if (compatibility.status === 'incompatible') tableBlockers.push({ kind: 'incompatible_type', sourceColumn: sourceColumn.name, targetColumn: targetColumn?.name || columnMapping.targetColumn, message: compatibility.message });
      if (compatibility.status === 'risky') tableWarnings.push({ kind: 'risky_cast', sourceColumn: sourceColumn.name, targetColumn: targetColumn?.name || columnMapping.targetColumn, message: compatibility.message });
      if (compatibility.status === 'compatible_with_transform') tableWarnings.push({ kind: 'transform_required', sourceColumn: sourceColumn.name, targetColumn: targetColumn?.name || columnMapping.targetColumn, message: compatibility.message });
      if (compatibility.status === 'provisioned') tableWarnings.push({ kind: 'target_column_will_be_created', sourceColumn: sourceColumn.name, targetColumn: columnMapping.targetColumn || sourceColumn.name });

      if (compatibility.status === 'incompatible') readiness = 'blocked';
      if (compatibility.status === 'risky' && readiness !== 'blocked') readiness = readiness === 'provision' ? 'provision' : 'review';
      if (compatibility.status === 'compatible_with_transform' && readiness !== 'blocked') readiness = readiness === 'provision' ? 'provision' : 'review';
      if (compatibility.status === 'provisioned' && readiness !== 'blocked') readiness = 'provision';

      if (sourceColumn.booleanish) {
        const sampleRows = await sampleSourceRows(mapping.sourceTable, 10);
        const invalidBooleanValues = sampleRows
          .map((row) => row[sourceColumn.name] ?? row.__raw)
          .filter((value) => value != null && !['0', '1', 0, 1, true, false, 'true', 'false'].includes(value));
        if (invalidBooleanValues.length) {
          tableWarnings.push({ kind: 'unexpected_boolean_values', sourceColumn: sourceColumn.name, samples: invalidBooleanValues.slice(0, 3) });
        }
      }
    }

    try {
      const sampleRows = await sampleSourceRows(mapping.sourceTable, 1);
      if (sampleRows.length) {
        for (const columnMapping of activeColumnMappings) {
          validateTransformRule(columnMapping.transform, { value: sampleRows[0]?.[columnMapping.sourceColumn], row: sampleRows[0] });
        }
        shouldIncludeRow({ row: sampleRows[0], tableMapping: mapping });
        transformRow({ row: sampleRows[0], tableMapping: mapping });
      }
    } catch (error) {
      tableWarnings.push({ kind: 'transform_runtime_warning', table: mapping.sourceTable, message: error.message || String(error) });
    }

    for (const requiredColumn of collectTargetRequirements(targetTable || { columns: [] })) {
      if (!mappedTargetColumns.has(requiredColumn.name)) {
        tableBlockers.push({ kind: 'unmapped_required_target_column', targetColumn: requiredColumn.name });
        readiness = 'blocked';
        readinessReasons.push(`Required target column ${requiredColumn.name} is not mapped`);
      }
    }

    if (tableBlockers.length) readiness = 'blocked';
    else if (tableWarnings.length && readiness === 'ready') readiness = 'review';

    tableReports.push({
      tableMappingId: mapping.id,
      sourceTable: mapping.sourceTable,
      targetTable: mapping.targetTable,
      blockers: tableBlockers,
      warnings: tableWarnings,
      columns: columnReports,
      completeness: deriveTableCompleteness(columnReports),
      readiness: {
        level: readiness,
        reasons: Array.from(new Set(readinessReasons)),
      },
      schemaAction: schemaEntry?.action || null,
    });
    blockers.push(...tableBlockers);
    warnings.push(...tableWarnings);
  }

  return {
    generatedAt: new Date().toISOString(),
    blockers,
    warnings,
    tables: tableReports,
    summary: {
      blockerCount: blockers.length,
      warningCount: warnings.length,
      tableCount: tableReports.length,
    },
  };
}

async function buildDryRunPreview({ project, sampleSourceRows }) {
  const previews = [];
  for (const mapping of (project.tableMappings || []).filter((item) => item.enabled !== false)) {
    const rows = await sampleSourceRows(mapping.sourceTable, 5, mapping);
    previews.push({
      sourceTable: mapping.sourceTable,
      targetTable: mapping.targetTable,
      columnMappings: mapping.columnMappings || [],
      rowFilter: mapping.rowFilter || null,
      sampleRows: rows,
      transformedRows: rows.map((row) => transformRow({ row, tableMapping: mapping })),
      filteredRowCount: rows.filter((row) => !shouldIncludeRow({ row, tableMapping: mapping })).length,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    tables: previews,
  };
}

async function validateRunReport({ run, persistence, project, countSourceRows, countTargetRows }) {
  const checkpoints = await persistence.listCheckpoints(run.id);
  const errors = await persistence.listErrors(run.id);
  const replays = typeof persistence.listReplays === 'function' ? await persistence.listReplays(run.id) : [];
  const tableVerification = await Promise.all((run.tableStatuses || []).map(async (table) => {
    let sourceRowCount = null;
    let targetRowCount = null;
    let rowCountMatch = null;
    let rowCountScope = 'not_checked';
    if (project && table.tableName && table.targetTable && typeof countSourceRows === 'function' && typeof countTargetRows === 'function') {
      try {
        sourceRowCount = await countSourceRows(table.tableName);
        targetRowCount = await countTargetRows(table.targetTable);
        const writeMode = table.writeDisposition?.writeMode || table.writeMode || null;
        const fullReplacement = writeMode === 'truncate' && (table.loadStrategy || 'historical_full') === 'historical_full';
        if (fullReplacement) {
          rowCountScope = 'full_replacement_table_count';
          rowCountMatch = targetRowCount === (table.inserted || 0) && sourceRowCount === (table.totalRows || 0);
        } else {
          rowCountScope = 'informational_total_table_count';
          rowCountMatch = null;
        }
      } catch {
        rowCountMatch = null;
      }
    }
    return {
      tableName: table.tableName,
      targetTable: table.targetTable,
      status: table.status,
      rowsInserted: table.inserted || 0,
      rowsRejected: table.rejected || 0,
      processed: table.processed || 0,
      totalRows: table.totalRows || 0,
      complete: table.status === 'done' || table.status === 'partial',
      sourceRowCount,
      targetRowCount,
      rowCountMatch,
      rowCountScope,
      aggregateMatch: null,
      keyCoverageMatch: null,
      trustLevel: rowCountMatch === false || table.status === 'error' ? 'needs_manual_review' : ((table.rejected || 0) > 0 ? 'verified_with_warnings' : 'verified'),
    };
  }));

  return {
    runId: run.id,
    status: run.status,
    counters: run.counters || {},
    checkpoints,
    errors,
    replays,
    tableVerification,
    executionProfile: run.executionProfile || null,
    validation: {
      success: run.status === 'done' && !errors.length,
      partialSuccess: errors.length > 0 && (run.counters?.rowsInserted || 0) > 0,
      warnings: (run.warnings || []).length,
      reconciledTables: tableVerification.filter((table) => table.complete).length,
      rowCountMatches: tableVerification.filter((table) => table.rowCountMatch === true).length,
      rowCountMismatches: tableVerification.filter((table) => table.rowCountMatch === false).length,
      aggregateMismatches: tableVerification.filter((table) => table.aggregateMatch === false).length,
      keyCoverageMismatches: tableVerification.filter((table) => table.keyCoverageMatch === false).length,
    },
    summary: {
      totalErrors: errors.length,
      totalCheckpoints: checkpoints.length,
      tablesDone: tableVerification.filter((table) => table.status === 'done').length,
      tablesPartial: tableVerification.filter((table) => table.status === 'partial').length,
      tablesErrored: tableVerification.filter((table) => table.status === 'error').length,
      consistencyMode: run.executionProfile?.consistencyMode || (run.executionProfile?.consistentRead?.enabled ? 'consistent-read' : 'best-effort'),
      concurrency: run.executionProfile?.concurrency || 1,
      batchSize: run.executionProfile?.batchSize || null,
      cdcMode: run.executionProfile?.cdcMode || 'off',
      cutoverMode: run.executionProfile?.cutoverMode || 'manual',
      scheduler: run.executionProfile?.scheduler || 'serial',
      layers: run.executionProfile?.layers || [],
      replayableErrors: errors.filter((item) => item.context?.phase === 'write' && item.rowPayload).length,
      replayRuns: replays.length,
    },
    anomalies: tableVerification
      .filter((table) => table.rowCountMatch === false || table.rowsRejected > 0 || table.status === 'error')
      .map((table) => ({
        tableName: table.tableName,
        targetTable: table.targetTable,
        status: table.status,
        rowCountMatch: table.rowCountMatch,
        rowsRejected: table.rowsRejected,
      })),
    audit: buildRunAuditReport({
      runId: run.id,
      status: run.status,
      summary: {
        totalErrors: errors.length,
        totalCheckpoints: checkpoints.length,
        tablesDone: tableVerification.filter((table) => table.status === 'done').length,
        tablesPartial: tableVerification.filter((table) => table.status === 'partial').length,
        tablesErrored: tableVerification.filter((table) => table.status === 'error').length,
      },
      validation: {
        rowCountMismatches: tableVerification.filter((table) => table.rowCountMatch === false).length,
        aggregateMismatches: tableVerification.filter((table) => table.aggregateMatch === false).length,
        keyCoverageMismatches: tableVerification.filter((table) => table.keyCoverageMatch === false).length,
      },
      anomalies: tableVerification
        .filter((table) => table.rowCountMatch === false || table.rowsRejected > 0 || table.status === 'error')
        .map((table) => ({
          tableName: table.tableName,
          targetTable: table.targetTable,
          status: table.status,
          rowCountMatch: table.rowCountMatch,
          rowsRejected: table.rowsRejected,
        })),
    }),
  };
}

module.exports = { classifyTypeCompatibility, analyzePreflight, buildDryRunPreview, validateRunReport };
