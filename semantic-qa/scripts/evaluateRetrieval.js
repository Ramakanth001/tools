const cases = require('../eval/relevance-cases.json');

const apiBase = String(process.env.SEMANTIC_QA_EVAL_API || 'http://127.0.0.1:8790/api').replace(/\/+$/, '');
const topK = Math.max(1, Math.min(20, Number(process.env.SEMANTIC_QA_EVAL_TOP_K || 5)));

const indexConnection = {
  connectionString: '',
  host: process.env.SEMANTIC_QA_EVAL_PG_HOST || '127.0.0.1',
  port: Number(process.env.SEMANTIC_QA_EVAL_PG_PORT || 5433),
  user: process.env.SEMANTIC_QA_EVAL_PG_USER || 'semantic_qa_indexer',
  password: process.env.SEMANTIC_QA_EVAL_PG_PASSWORD || '',
  database: process.env.SEMANTIC_QA_EVAL_PG_DATABASE || 'universal_qa_index',
  sslMode: process.env.SEMANTIC_QA_EVAL_PG_SSL_MODE || 'disable',
};

async function search(question) {
  const response = await fetch(`${apiBase}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      indexConnection,
      ollamaBaseUrl: process.env.SEMANTIC_QA_EVAL_OLLAMA || 'http://127.0.0.1:11434',
      question,
      topK,
      threshold: Number(process.env.SEMANTIC_QA_EVAL_THRESHOLD || 0.50),
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Search returned HTTP ${response.status}`);
  return payload;
}

async function run() {
  const results = [];
  for (const entry of cases) {
    const payload = await search(entry.question);
    const groups = payload.matches.map((match) => match.sourceGroup || match.sourceId);
    const rank = groups.findIndex((group) => entry.relevantSourceGroups.includes(group)) + 1;
    const relevantInTop = groups.filter((group) => entry.relevantSourceGroups.includes(group)).length;
    const minimumRelevantInTop = Number(entry.minimumRelevantInTop || 1);
    results.push({
      question: entry.question,
      pass: rank > 0 && relevantInTop >= minimumRelevantInTop,
      rank: rank || null,
      relevantInTop,
      minimumRelevantInTop,
      topGroups: groups,
    });
  }
  const recallAtK = results.filter((result) => result.pass).length / results.length;
  const meanReciprocalRank = results.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0) / results.length;
  process.stdout.write(`${JSON.stringify({ topK, recallAtK, meanReciprocalRank, results }, null, 2)}\n`);
  if (recallAtK < 1) process.exitCode = 1;
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
