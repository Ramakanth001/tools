const fs = require('node:fs');
const path = require('node:path');
const { evaluationIndexConnection } = require('./deepSearchEvaluationConfig');
const database = require('../src/database');

async function buildCandidateIndex() {
  const baseConn = evaluationIndexConnection();
  const rootConn = { ...baseConn, database: 'postgres' };
  const candidateDbName = process.env.CANDIDATE_PG_DATABASE || 'universal_qa_v3_candidate';
  const comparisonReportPath = path.join(__dirname, '..', 'benchmark', 'results', 'candidate_index_comparison.json');

  console.log(`Building candidate index database: ${candidateDbName} from ${baseConn.database}...`);

  await database.withPool(rootConn, async (pool) => {
    // Terminate existing connections to template database if needed
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [baseConn.database]);

    // Drop old candidate if exists
    await pool.query(`DROP DATABASE IF EXISTS ${candidateDbName}`);

    // Create candidate database from template
    await pool.query(`CREATE DATABASE ${candidateDbName} WITH TEMPLATE ${baseConn.database}`);
  });

  console.log(`Candidate database ${candidateDbName} created successfully.`);

  const candidateConn = { ...baseConn, database: candidateDbName };

  const stats = {
    templateDatabase: baseConn.database,
    candidateDatabase: candidateDbName,
    createdAt: new Date().toISOString(),
    removedUnits: [],
  };

  await database.withPool(candidateConn, async (pool) => {
    // Find the non-Swami byline answer units in candidate DB
    const nonSwamiUnitsRes = await pool.query(`
      SELECT answer_unit_id, source_id, substring(unit_text from 1 for 60) as prefix
      FROM semantic_qa.answer_units
      WHERE unit_text ~* '^\\s*\\[By\\s+'
        AND NOT unit_text ~* '^\\s*\\[By\\s+((?:(?:Shri|Sri)\\s+)?(?:Datta\\s*Swami|Swami))\\]'
    `);

    stats.removedUnits = nonSwamiUnitsRes.rows;

    if (nonSwamiUnitsRes.rows.length > 0) {
      const ids = nonSwamiUnitsRes.rows.map((r) => r.answer_unit_id);
      console.log(`Removing ${ids.length} non-Swami byline units:`, ids);
      await pool.query(`
        DELETE FROM semantic_qa.answer_units
        WHERE answer_unit_id = ANY($1::text[])
      `, [ids]);
    }

    const countsRes = await pool.query(`
      SELECT
        (SELECT count(*) FROM semantic_qa.records) as records,
        (SELECT count(*) FROM semantic_qa.passages) as passages,
        (SELECT count(*) FROM semantic_qa.answer_units) as answer_units
    `);
    stats.candidateCounts = countsRes.rows[0];
  });

  fs.mkdirSync(path.dirname(comparisonReportPath), { recursive: true });
  fs.writeFileSync(comparisonReportPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log('Candidate index comparison saved to:', comparisonReportPath);
  console.log(stats);
}

if (require.main === module) {
  buildCandidateIndex().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildCandidateIndex };
