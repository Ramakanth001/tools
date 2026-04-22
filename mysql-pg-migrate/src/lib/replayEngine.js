const crypto = require('node:crypto');
const { transformRow } = require('./valueTransforms');
const { writeRowsToPostgres } = require('./postgresIntrospector');

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function findTableMapping(project, tableName) {
  return (project.tableMappings || []).find((table) => table.sourceTable === tableName || table.targetTable === tableName) || null;
}

async function replayCorrectedRows({ persistence, runId, project, targetConnection, corrections = [] }) {
  const results = [];
  for (const correction of corrections) {
    const tableMapping = findTableMapping(project, correction.tableName);
    if (!tableMapping) {
      results.push({ errorId: correction.errorId, status: 'skipped', reason: 'table_mapping_not_found' });
      continue;
    }

    const sourceRow = correction.sourceRow || correction.rowPayload || correction.correctedRow || {};
    const transformedRow = correction.transformedRow || transformRow({ row: sourceRow, tableMapping });
    const classification = correction.classification || (correction.errorId ? 'replayed-error' : 'manual-correction');
    try {
      const outcome = await writeRowsToPostgres(targetConnection, {
        schema: project.targetSchema,
        tableName: tableMapping.targetTable,
        rows: [transformedRow],
        mode: tableMapping.writeMode === 'upsert' ? 'upsert' : 'append',
        conflictKeys: tableMapping.conflictKeys || [],
      });
      results.push({
        errorId: correction.errorId,
        tableName: correction.tableName,
        status: 'replayed',
        classification,
        rowCount: outcome.rowCount || 1,
      });
    } catch (error) {
      results.push({
        errorId: correction.errorId,
        tableName: correction.tableName,
        status: 'failed',
        classification,
        reason: error.message || String(error),
      });
    }
  }

  const replayRecord = {
    id: makeId('replay'),
    runId,
    projectId: project.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    corrections,
    results,
    summary: {
      total: corrections.length,
      replayed: results.filter((item) => item.status === 'replayed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
    },
  };

  await persistence.saveReplay(replayRecord);
  await persistence.saveReport({
    id: makeId('replayreport'),
    projectId: project.id,
    runId,
    type: 'replay',
    createdAt: new Date().toISOString(),
    report: replayRecord,
  });

  return replayRecord;
}

module.exports = { replayCorrectedRows };