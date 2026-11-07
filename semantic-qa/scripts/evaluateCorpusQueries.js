const database = require('../src/database');

const apiBase = String(process.env.SEMANTIC_QA_EVAL_API || 'http://127.0.0.1:8790/api').replace(/\/+$/, '');
const topK = Math.max(1, Math.min(20, Number(process.env.SEMANTIC_QA_EVAL_TOP_K || 5)));
const threshold = Number(process.env.SEMANTIC_QA_EVAL_THRESHOLD || 0.49);
const minimumRecallAt1 = Number(process.env.SEMANTIC_QA_EVAL_MIN_RECALL_AT_1 || 0.95);
const minimumRecallAtK = Number(process.env.SEMANTIC_QA_EVAL_MIN_RECALL_AT_K || 0.98);
const maximumWrongStrongRate = Number(process.env.SEMANTIC_QA_EVAL_MAX_WRONG_STRONG_RATE || 0.02);
const caseLimit = Math.max(0, Number(process.env.SEMANTIC_QA_EVAL_CASE_LIMIT || 0));

const indexConnection = {
  connectionString: '',
  host: process.env.SEMANTIC_QA_EVAL_PG_HOST || '127.0.0.1',
  port: Number(process.env.SEMANTIC_QA_EVAL_PG_PORT || 5433),
  user: process.env.SEMANTIC_QA_EVAL_PG_USER || 'semantic_qa_indexer',
  password: process.env.SEMANTIC_QA_EVAL_PG_PASSWORD || '',
  database: process.env.SEMANTIC_QA_EVAL_PG_DATABASE || 'universal_qa_index',
  sslMode: process.env.SEMANTIC_QA_EVAL_PG_SSL_MODE || 'disable',
};

async function loadCases() {
  return database.withPool(indexConnection, async (pool) => {
    const result = await pool.query(`
      SELECT DISTINCT ON (source_group)
             source_group AS "sourceGroup",
             coalesce(nullif(metadata->>'question_context', ''), question) AS question
      FROM semantic_qa.records
      WHERE metadata->>'source_type' = 'qa'
        AND length(coalesce(nullif(metadata->>'question_context', ''), question)) BETWEEN 1 AND 20000
      ORDER BY source_group, source_order NULLS FIRST, source_id
    `);
    return caseLimit ? result.rows.slice(0, caseLimit) : result.rows;
  });
}

async function search(question) {
  const response = await fetch(`${apiBase}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      indexConnection,
      ollamaBaseUrl: process.env.SEMANTIC_QA_EVAL_OLLAMA || 'http://127.0.0.1:11434',
      question,
      topK,
      threshold,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Search returned HTTP ${response.status}`);
  return payload;
}

async function run() {
  const cases = await loadCases();
  if (!cases.length) throw new Error('No structured QA source_context cases were found in the live index');

  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index];
    const payload = await search(entry.question);
    const groups = payload.matches.map((match) => match.sourceGroup || match.sourceId);
    const rank = groups.indexOf(entry.sourceGroup) + 1;
    results.push({
      sourceGroup: entry.sourceGroup,
      rank: rank || null,
      strongMatch: payload.strongMatch,
      acceptedSourceGroup: payload.acceptedMatch?.sourceGroup || payload.acceptedMatch?.sourceId || null,
      question: entry.question,
      topGroups: groups,
    });
    if ((index + 1) % 25 === 0 || index + 1 === cases.length) {
      process.stderr.write(`Evaluated ${index + 1}/${cases.length} corpus questions\n`);
    }
  }

  const top1 = results.filter((result) => result.rank === 1).length;
  const recalled = results.filter((result) => result.rank).length;
  const wrongTop = results.filter((result) => result.rank !== 1);
  const wrongStrong = wrongTop.filter((result) => result.strongMatch);
  const summary = {
    cases: results.length,
    topK,
    threshold,
    recallAt1: top1 / results.length,
    recallAtK: recalled / results.length,
    wrongTopStrongRate: wrongStrong.length / results.length,
    wrongTopConditionalStrongRate: wrongTop.length ? wrongStrong.length / wrongTop.length : 0,
    wrongTopCount: wrongTop.length,
    wrongTopStrongCount: wrongStrong.length,
    misses: results.filter((result) => !result.rank),
    wrongStrong: wrongStrong.slice(0, 25),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.recallAt1 < minimumRecallAt1 ||
      summary.recallAtK < minimumRecallAtK ||
      summary.wrongTopStrongRate > maximumWrongStrongRate) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
