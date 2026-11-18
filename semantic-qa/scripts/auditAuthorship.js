const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { evaluationIndexConnection } = require('./deepSearchEvaluationConfig');
const database = require('../src/database');
const { parseAnswerUnits, isCitableSwamiUnit } = require('../src/corpusStructure');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function gitContext(rootDir) {
  try {
    const gitSha = execSync('git rev-parse HEAD', { cwd: rootDir }).toString().trim();
    const statusOut = execSync('git status --porcelain', { cwd: rootDir }).toString().trim();
    return {
      gitSha,
      gitDirty: statusOut.length > 0,
    };
  } catch {
    return { gitSha: 'unknown', gitDirty: false };
  }
}

async function auditAuthorship() {
  const conn = evaluationIndexConnection();
  const rootDir = path.resolve(__dirname, '..');
  const defaultReportName = conn.database === 'universal_qa_v3_candidate'
    ? 'authorship_audit_candidate_report.json'
    : 'authorship_audit_report.json';
  const reportPath = process.env.AUTHORSHIP_AUDIT_REPORT || path.join(rootDir, 'benchmark', 'results', defaultReportName);
  const git = gitContext(rootDir);

  const indexStatus = await database.getIndexStatus(conn).catch(() => ({}));

  const audit = {
    startedAt: new Date().toISOString(),
    database: conn.database,
    schema: 'semantic_qa',
    retrievalSchemaVersion: indexStatus.corpus?.retrievalSchemaVersion || 'unknown',
    embeddingFormatVersion: indexStatus.corpus?.embeddingFormatVersion || 'unknown',
    embeddingModel: indexStatus.corpus?.embeddingModel || 'unknown',
    embeddingModelDigest: indexStatus.corpus?.embeddingModelDigest || 'unknown',
    gitSha: git.gitSha,
    gitDirty: git.gitDirty,
    totalRecordsAudited: 0,
    recordsWithByline: 0,
    bylineBreakdown: {},
    nonSwamiBylineRecords: 0,
    nonSwamiCitableUnitsCreated: 0,
    mixedDocumentsAudited: 0,
    flaggedViolations: [],
    auditedEntries: [],
    databaseIndexAudit: {
      totalAnswerUnitsInDb: 0,
      nonSwamiBylineUnitsInDb: [],
      offsetMismatchCount: 0,
      offsetMismatches: [],
      contentHashMismatchCount: 0,
      contentHashMismatches: [],
    },
  };

  await database.withPool(conn, async (pool) => {
    const client = await pool.connect();
    try {
      const recordsResult = await client.query(`
        SELECT source_id, question, answer AS text, metadata
        FROM semantic_qa.records
        ORDER BY source_id
      `);

      audit.totalRecordsAudited = recordsResult.rows.length;
      const recordsMap = new Map();

      for (const row of recordsResult.rows) {
        recordsMap.set(row.source_id, row);
        const text = String(row.text || '');
        const bylineMatch = text.match(/^\s*\[By\s+([^\]\r\n]+)\]/iu);
        if (!bylineMatch) continue;

        audit.recordsWithByline += 1;
        const detectedByline = bylineMatch[1].trim();
        audit.bylineBreakdown[detectedByline] = (audit.bylineBreakdown[detectedByline] || 0) + 1;

        const isSwamiByline = /^(?:(?:Shri|Sri)\s+)?(?:Datta\s*Swami|Swami)$/iu.test(detectedByline);
        if (!isSwamiByline) {
          audit.nonSwamiBylineRecords += 1;
        }

        const parsed = parseAnswerUnits({
          text,
          sourceId: row.source_id,
          sourceType: row.metadata?.source_type || (String(row.source_id).startsWith('discourse') ? 'discourse' : 'qa'),
          question: row.question,
          language: row.metadata?.language || '',
          author: row.metadata?.author || '',
        });

        const citableUnits = (parsed.units || []).filter((u) => isCitableSwamiUnit(u));
        const nonSwamiUnits = (parsed.units || []).filter((u) => !isCitableSwamiUnit(u));

        if (!isSwamiByline && parsed.units.length > 0) {
          const hasSwamiReply = parsed.units.some((u) => u.unitKind === 'swami_reply');
          if (hasSwamiReply) {
            audit.mixedDocumentsAudited += 1;
          }
        }

        if (nonSwamiUnits.length > 0) {
          audit.nonSwamiCitableUnitsCreated += nonSwamiUnits.length;
          audit.flaggedViolations.push({
            sourceId: row.source_id,
            detectedByline,
            nonSwamiUnitIds: nonSwamiUnits.map((u) => u.answerUnitId),
          });
        }

        audit.auditedEntries.push({
          sourceId: row.source_id,
          detectedByline,
          isSwamiByline,
          totalUnitsParsed: parsed.units.length,
          citableSwamiUnits: citableUnits.length,
          ignoredSpans: (parsed.ignored || []).length,
          ambiguities: (parsed.ambiguities || []).length,
          unitIds: citableUnits.map((u) => u.answerUnitId),
        });
      }

      // Audit existing answer_units table in the database
      const unitsResult = await client.query(`
        SELECT answer_unit_id, source_id, unit_text, unit_kind, author,
               start_offset, end_offset, content_hash
        FROM semantic_qa.answer_units
        ORDER BY answer_unit_id
      `);

      audit.databaseIndexAudit.totalAnswerUnitsInDb = unitsResult.rows.length;

      for (const unit of unitsResult.rows) {
        const text = String(unit.unit_text || '');
        const bylineMatch = text.match(/^\s*\[By\s+([^\]\r\n]+)\]/iu);
        if (bylineMatch) {
          const byline = bylineMatch[1].trim();
          const isSwami = /^(?:(?:Shri|Sri)\s+)?(?:Datta\s*Swami|Swami)$/iu.test(byline);
          if (!isSwami) {
            audit.databaseIndexAudit.nonSwamiBylineUnitsInDb.push({
              answerUnitId: unit.answer_unit_id,
              sourceId: unit.source_id,
              byline,
            });
          }
        }

        // Validate content hash
        const computedHash = sha256(text);
        if (unit.content_hash && unit.content_hash !== computedHash) {
          audit.databaseIndexAudit.contentHashMismatchCount += 1;
          audit.databaseIndexAudit.contentHashMismatches.push({
            answerUnitId: unit.answer_unit_id,
            expected: computedHash,
            actual: unit.content_hash,
          });
        }

        // Validate source offsets against source record
        const parentRecord = recordsMap.get(unit.source_id);
        if (parentRecord && Number.isInteger(unit.start_offset) && Number.isInteger(unit.end_offset)) {
          const expectedSlice = String(parentRecord.text || '').slice(unit.start_offset, unit.end_offset);
          if (expectedSlice !== text) {
            audit.databaseIndexAudit.offsetMismatchCount += 1;
            audit.databaseIndexAudit.offsetMismatches.push({
              answerUnitId: unit.answer_unit_id,
              startOffset: unit.start_offset,
              endOffset: unit.end_offset,
            });
          }
        }
      }
    } finally {
      client.release();
    }
  });

  audit.finishedAt = new Date().toISOString();
  audit.success = audit.nonSwamiCitableUnitsCreated === 0
    && audit.flaggedViolations.length === 0
    && audit.databaseIndexAudit.offsetMismatchCount === 0
    && audit.databaseIndexAudit.contentHashMismatchCount === 0;

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(audit, null, 2)}\n`);

  process.stdout.write(JSON.stringify({
    success: audit.success,
    totalRecordsAudited: audit.totalRecordsAudited,
    recordsWithByline: audit.recordsWithByline,
    nonSwamiBylineRecords: audit.nonSwamiBylineRecords,
    nonSwamiCitableUnitsCreated: audit.nonSwamiCitableUnitsCreated,
    flaggedViolations: audit.flaggedViolations.length,
    databaseIndexAudit: {
      totalAnswerUnitsInDb: audit.databaseIndexAudit.totalAnswerUnitsInDb,
      nonSwamiBylineUnitsInDb: audit.databaseIndexAudit.nonSwamiBylineUnitsInDb.length,
      offsetMismatchCount: audit.databaseIndexAudit.offsetMismatchCount,
      contentHashMismatchCount: audit.databaseIndexAudit.contentHashMismatchCount,
    },
    reportPath,
  }, null, 2) + '\n');

  if (!audit.success) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  auditAuthorship().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { auditAuthorship };
