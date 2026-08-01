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
      threshold: Number(process.env.SEMANTIC_QA_EVAL_THRESHOLD || 0.49),
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
    const sourceIds = payload.matches.map((match) => match.sourceId);
    const relevantGroups = entry.relevantSourceGroups || [];
    const relevantSourceIds = entry.relevantSourceIds || [];
    const rank = relevantGroups.length
      ? groups.findIndex((group) => relevantGroups.includes(group)) + 1
      : 0;
    const sourceIdRank = relevantSourceIds.length
      ? sourceIds.findIndex((sourceId) => relevantSourceIds.includes(sourceId)) + 1
      : 0;
    const relevantInTop = groups.filter((group) => relevantGroups.includes(group)).length;
    const minimumRelevantInTop = Number(entry.minimumRelevantInTop || (relevantGroups.length ? 1 : 0));
    const retrievalPass = !relevantGroups.length ||
      (rank > 0 && relevantInTop >= minimumRelevantInTop && (!entry.requireTop1 || rank === 1));
    const answerPass = !relevantSourceIds.length || sourceIdRank > 0;
    const confidencePass = typeof entry.expectStrongMatch !== 'boolean' ||
      payload.strongMatch === entry.expectStrongMatch;
    results.push({
      question: entry.question,
      pass: retrievalPass && answerPass && confidencePass,
      rank: rank || null,
      sourceIdRank: sourceIdRank || null,
      relevantInTop,
      minimumRelevantInTop,
      strongMatch: payload.strongMatch,
      acceptedSourceId: payload.acceptedMatch?.sourceId || null,
      topGroups: groups,
      topSourceIds: sourceIds,
    });
  }
  const positiveResults = results.filter((_result, index) => (cases[index].relevantSourceGroups || []).length);
  const negativeResults = results.filter((_result, index) => cases[index].expectStrongMatch === false);
  const recallAtK = positiveResults.length
    ? positiveResults.filter((result) => result.rank).length / positiveResults.length
    : 1;
  const top1Accuracy = positiveResults.length
    ? positiveResults.filter((result) => result.rank === 1).length / positiveResults.length
    : 1;
  const meanReciprocalRank = positiveResults.length
    ? positiveResults.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0) / positiveResults.length
    : 1;
  const falseAcceptRate = negativeResults.length
    ? negativeResults.filter((result) => result.strongMatch).length / negativeResults.length
    : 0;
  const passed = results.filter((result) => result.pass).length;
  process.stdout.write(`${JSON.stringify({
    topK,
    passed,
    total: results.length,
    recallAtK,
    top1Accuracy,
    meanReciprocalRank,
    falseAcceptRate,
    results,
  }, null, 2)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
