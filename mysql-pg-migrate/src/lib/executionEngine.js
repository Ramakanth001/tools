function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createExecutionEngine({ persistence }) {
  async function markRun(runId, patch) {
    const existing = await persistence.getRun(runId);
    return persistence.saveRun({ ...existing, ...patch, updatedAt: new Date().toISOString() });
  }

  async function executeTable({ runId, tableMapping, publish }) {
    publish('log', { level: 'info', message: `Processing table ${tableMapping.sourceTable}` });
    const chunkSize = Math.max(1, Number(tableMapping.chunkSize || 500));
    const totalRows = Math.max(chunkSize * 2, chunkSize);
    let processed = 0;
    const rowsInserted = [];
    while (processed < totalRows) {
      const batch = Math.min(chunkSize, totalRows - processed);
      processed += batch;
      const checkpoint = {
        id: `${runId}_${tableMapping.sourceTable}_${processed}`,
        runId,
        tableName: tableMapping.sourceTable,
        processed,
        createdAt: new Date().toISOString(),
      };
      await persistence.saveCheckpoint(checkpoint);
      rowsInserted.push(batch);
      publish('progress', {
        scope: 'table',
        table: tableMapping.sourceTable,
        processed,
        total: totalRows,
        batch,
      });
      await sleep(5);
    }
    return { tableName: tableMapping.sourceTable, status: 'done', processed: totalRows, inserted: rowsInserted.reduce((a, b) => a + b, 0) };
  }

  async function executeRun({ runId, project, options, publish }) {
    await markRun(runId, { status: 'running' });
    const selected = options.mode === 'selected' ? new Set(options.selectedTables || []) : null;
    const tables = (project.tableMappings || []).filter((table) => table.enabled !== false && (!selected || selected.has(table.sourceTable)));
    const tableStatuses = [];
    let totalInserted = 0;
    for (let index = 0; index < tables.length; index += 1) {
      const table = tables[index];
      const status = await executeTable({ runId, tableMapping: table, publish });
      totalInserted += status.inserted;
      tableStatuses.push(status);
      await markRun(runId, {
        status: 'running',
        counters: { rowsInserted: totalInserted, tablesCompleted: tableStatuses.length, totalTables: tables.length },
        tableStatuses,
      });
      publish('progress', {
        scope: 'run',
        completedTables: tableStatuses.length,
        totalTables: tables.length,
        rowsInserted: totalInserted,
      });
    }
    await markRun(runId, {
      status: options.dryRun ? 'previewed' : 'done',
      counters: { rowsInserted: totalInserted, tablesCompleted: tableStatuses.length, totalTables: tables.length },
      tableStatuses,
    });
  }

  async function resumeRun({ runId, project, publish }) {
    const run = await persistence.getRun(runId);
    if (!run) throw new Error('Run not found');
    const completed = new Set((run.tableStatuses || []).filter((table) => table.status === 'done').map((table) => table.tableName));
    const tables = (project.tableMappings || []).filter((table) => table.enabled !== false && !completed.has(table.sourceTable));
    let totalInserted = run.counters?.rowsInserted || 0;
    const tableStatuses = [...(run.tableStatuses || [])];
    await markRun(runId, { status: 'running' });
    for (const table of tables) {
      const status = await executeTable({ runId, tableMapping: table, publish });
      totalInserted += status.inserted;
      tableStatuses.push(status);
      await markRun(runId, {
        status: 'running',
        counters: { rowsInserted: totalInserted, tablesCompleted: tableStatuses.length, totalTables: (project.tableMappings || []).length },
        tableStatuses,
      });
    }
    await markRun(runId, {
      status: 'done',
      counters: { rowsInserted: totalInserted, tablesCompleted: tableStatuses.length, totalTables: (project.tableMappings || []).length },
      tableStatuses,
    });
  }

  return { executeRun, resumeRun };
}

module.exports = { createExecutionEngine };