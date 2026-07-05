const crypto = require('node:crypto');
const { transformRowsForTable } = require('./transformEngine');
const { writeRowsToPostgres } = require('./postgresIntrospector');

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function findTableMapping(project, tableName) {
  return (project.tableMappings || []).find((table) => table.sourceTable === tableName || table.targetTable === tableName) || null;
}

async function replayCorrectedRows({ persistence, runId, project, targetConnection, sourceConnection, corrections = [] }) {
  const results = [];
  for (const correction of corrections) {
    const tableMapping = findTableMapping(project, correction.tableName);
    if (!tableMapping) {
      results.push({ errorId: correction.errorId, status: 'skipped', reason: 'table_mapping_not_found' });
      continue;
    }

    const sourceRow = correction.sourceRow || correction.rowPayload || correction.correctedRow || {};
    let transformedRow = correction.transformedRow || null;
    if (!transformedRow) {
      const transformed = await transformRowsForTable({
        rows: [sourceRow],
        tableMapping,
        sourceConnection,
        schema: project.sourceSchema,
      });
      if (transformed.rejected?.length) {
        results.push({
          errorId: correction.errorId,
          tableName: correction.tableName,
          status: 'failed',
          classification: correction.classification || 'manual-correction',
          reason: transformed.rejected[0].error?.message || String(transformed.rejected[0].error),
        });
        continue;
      }
      transformedRow = transformed.transformedRows[0] || null;
    }
    if (!transformedRow) {
      results.push({ errorId: correction.errorId, tableName: correction.tableName, status: 'skipped', reason: 'row_filtered_by_transform' });
      continue;
    }
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
