const assert = require('node:assert/strict');
const database = require('../src/database');
const { sha256 } = require('../src/corpusStructure');

const QUESTION = 'I want promotion in my job can I ask God to give me that boon?';
const apiBase = String(process.env.SEMANTIC_QA_EVAL_API || 'http://127.0.0.1:8790/api').replace(/\/+$/u, '');
const pollIntervalMs = Math.max(250, Number(process.env.SEMANTIC_QA_EVAL_POLL_MS) || 2000);
const deadlineMs = Math.min(46 * 60 * 1000, Math.max(60_000, Number(process.env.SEMANTIC_QA_EVAL_DEADLINE_MS) || 45 * 60 * 1000));
const indexConnection = {
  connectionString: '',
  host: process.env.SEMANTIC_QA_EVAL_PG_HOST || '127.0.0.1',
  port: Number(process.env.SEMANTIC_QA_EVAL_PG_PORT || 5433),
  user: process.env.SEMANTIC_QA_EVAL_PG_USER || 'semantic_qa_indexer',
  password: process.env.SEMANTIC_QA_EVAL_PG_PASSWORD || '',
  database: process.env.SEMANTIC_QA_EVAL_PG_DATABASE || 'universal_qa_index',
  sslMode: process.env.SEMANTIC_QA_EVAL_PG_SSL_MODE || 'disable',
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Search Engine returned HTTP ${response.status}`);
  return payload;
}

async function runDeepReplay() {
  const search = await api('/search', {
    method: 'POST',
    body: JSON.stringify({
      indexConnection,
      ollamaBaseUrl: process.env.SEMANTIC_QA_EVAL_OLLAMA || 'http://127.0.0.1:11434',
      question: QUESTION,
      searchMode: 'semantic',
      topK: 20,
      threshold: Number(process.env.SEMANTIC_QA_EVAL_THRESHOLD || 0.49),
      summary: {
        enabled: false,
        mode: 'deep',
        deepModel: 'qwen3:14b-q8_0',
        deliberation: 'maximum',
        deepMaxRecords: 100,
        parallelRequests: 1,
        requestTimeoutMs: 600000,
        hardwarePreference: 'auto',
      },
    }),
  });
  assert.ok(search.deepSummaryJob?.id, 'Deep Search did not return a job ID');
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const payload = await api(`/deep-summary/${encodeURIComponent(search.deepSummaryJob.id)}`);
    const job = payload.job;
    process.stderr.write(`\r${job.currentOperation || job.phase} · ${job.elapsedSeconds || 0}s`);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      process.stderr.write('\n');
      if (job.status !== 'completed') throw new Error(job.error || `Deep Search ended as ${job.status}`);
      return job.result;
    }
    await wait(pollIntervalMs);
  }
  throw new Error('The live Q8 replay exceeded its benchmark deadline');
}

async function verifyExactEvidence(evidence) {
  const units = await database.getAnswerUnits(indexConnection, evidence.map((item) => item.sourceId));
  const byId = new Map(units.map((unit) => [unit.answerUnitId, unit]));
  for (const item of evidence) {
    const unit = byId.get(item.answerUnitId);
    assert.ok(unit, `Missing answer unit ${item.answerUnitId}`);
    assert.equal(unit.author, 'Swami', `${item.answerUnitId} is not authored by Swami`);
    assert.ok(['swami_reply', 'swami_teaching'].includes(unit.unitKind), `${item.answerUnitId} is not citable`);
    assert.ok(item.start >= unit.start && item.end <= unit.end && item.end > item.start, `${item.answerUnitId} has invalid offsets`);
    assert.equal(unit.displayText.slice(item.start, item.end), item.text, `${item.answerUnitId} is not an exact display_text slice`);
    assert.equal(sha256(item.text), item.contentHash, `${item.answerUnitId} has a changed evidence hash`);
  }
}

async function run() {
  const status = await database.getIndexStatus(indexConnection);
  assert.equal(status.corpus?.retrievalSchemaVersion, 'answer-unit-v5', 'Build and activate the role-aware v5 index before running this benchmark');
  const result = await runDeepReplay();
  assert.equal(result.answerStatus, 'related_teachings', 'The promotion question must not be presented as a literal/direct answer');
  assert.ok(result.evidence.length, 'The promotion question should return verified related teachings');

  const sourceIdsRead = new Set(result.audit?.sourceIdsRead || []);
  assert.ok(sourceIdsRead.has('discourse:2296'), 'Deep Search did not reconstruct and read discourse:2296');
  assert.ok(sourceIdsRead.has('discourse:5495'), 'Deep Search did not reconstruct and read the relevant discourse:5495 teaching');

  const evidenceSources = new Set(result.evidence.map((item) => item.sourceId));
  assert.ok(evidenceSources.has('discourse:2296'), 'The answer omitted the Swami reply from discourse:2296');
  assert.ok(!evidenceSources.has('discourse:4071'), 'A personal promotion experience was cited without an examples request');
  const prohibitedFragments = [
    'The Lord will certainly grant your boon because you are the greatest',
    'with God. You can just chant some prayers.',
  ];
  for (const fragment of prohibitedFragments) {
    assert.ok(!result.evidence.some((item) => item.text.includes(fragment)), `An orphaned legacy fragment was cited: ${fragment}`);
  }
  for (const item of result.evidence.filter((entry) => entry.sourceId === 'discourse:896')) {
    assert.equal(item.storyComplete, true, 'discourse:896 was admitted without a complete story');
    assert.match(item.text, /She killed him!/u, 'discourse:896 omitted the story consequence');
    assert.match(item.text, /Hence, we shall have full control on our desires/u, 'discourse:896 omitted Swami\'s explicit lesson');
  }
  await verifyExactEvidence(result.evidence);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    question: QUESTION,
    answerStatus: result.answerStatus,
    evidence: result.evidence.map((item) => ({ sourceId: item.sourceId, answerUnitId: item.answerUnitId, start: item.start, end: item.end })),
    audit: result.audit,
  }, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
