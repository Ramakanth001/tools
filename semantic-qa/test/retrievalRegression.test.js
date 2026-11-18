const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { requireToolDep } = require('../requireToolDep');
const core = require('../src/core');
const { registerSemanticQaRoutes } = require('../src/registerRoutes');
const { buildSemanticSummary } = require('../src/semanticSummary');
const { parseAnswerUnits, buildDiscoveryTexts } = require('../src/corpusStructure');

function row(sourceId, text, similarity, extra = {}) {
  return { sourceId, question: 'General discourse', answer: text, answerUnitId: `${sourceId}:answer:1`,
    passageIndex: 0, passageText: text, passageStart: 0, passageEnd: text.length,
    similarity, author: 'Swami', contextComplete: true, storyComplete: true, metadata: {}, ...extra };
}

test('threshold and phrase precedence are applied before ranking limits', () => {
  const rows = [
    row('weak', 'The quoted phrase remains here.', 0.1, { discoveryExact: true, discoveryAnswerUnitId: 'weak:answer:1' }),
    row('strong', 'An independently relevant complete answer.', 0.9),
  ];
  const ranked = core.rerankPassageMatches(rows, 'What does "quoted phrase" mean?', 1, 0.45);
  assert.equal(ranked[0].sourceId, 'strong');
});

test('unpaired discovery and associated question strings cannot certify an answer', () => {
  const ranked = core.rerankPassageMatches([row('weak', 'An unrelated answer.', 0.1, {
    discoveryExact: true, discoverySimilarity: 1, associatedQuestion: 'What is devotion?',
  })], 'What is devotion?', 5, 0.45);
  assert.equal(ranked[0].matchedPassages[0].isExact, false);
  assert.equal(core.buildSearchResponse(ranked, 0.45).strongMatch, false);
  const parsed = parseAnswerUnits({ sourceId: 'qa', sourceType: 'qa', question: 'What is devotion?', text: 'A complete reply.' });
  const discoveries = buildDiscoveryTexts({ sourceId: 'qa', question: 'What is devotion?', answer: 'A complete reply.', metadata: { source_type: 'qa' } }, parsed);
  assert.equal(discoveries.find((item) => item.kind === 'title').answerUnitId, null);
  assert.equal(discoveries.find((item) => item.kind === 'paired_question').answerUnitId, parsed.units[0].answerUnitId);
});

test('a source with several passages cannot crowd a stronger second source out of a database cap', () => {
  const rows = [
    row('first', 'A highly relevant teaching.', 0.95),
    row('first', 'A weaker sibling.', 0.3, { passageIndex: 1 }),
    row('second', 'Another relevant teaching.', 0.8),
  ];
  assert.deepEqual(core.rankPassageRows(rows, 'How should I act?', 2, 0.45)
    .map((item) => item.sourceId), ['first', 'second']);
});

test('Indic lexical expansion preserves complete Telugu and Malayalam words', () => {
  for (const word of ['సాధన', 'నేమి', 'സ്വാമി', 'ഭക്തി']) {
    assert.ok(core.buildLexicalQuery(word, { expandSpiritual: true }).split(' OR ').includes(word));
  }
});

test('evidence validation falls back within a source before deduplication', async () => {
  const invalid = 'Once there was a man who walked away.';
  const valid = 'We should perform our duties without attachment.';
  const answer = `${invalid}\n\n${valid}`;
  for (const badFlags of [{ storyComplete: false }, { contextComplete: false }, { author: 'Devotee' }, { passageStart: 1 }]) {
    const ranked = core.rerankPassageMatches([
      row('source', invalid, 0.9, { answer, ...badFlags }),
      row('source', valid, 0.8, { answer, passageIndex: 1, passageStart: invalid.length + 2, passageEnd: answer.length }),
    ], 'How should I act?', 5, 0.45);
    const result = await buildSemanticSummary({ question: 'How should I act?', matches: ranked, threshold: 0.45 });
    assert.equal(result.summary.status, 'ready');
    assert.equal(result.summary.text, valid);
    assert.equal(result.summary.answerStatus, 'related_teachings');
  }
});

test('production HTTP route finds strong answers at topK one and clears rejected evidence', async () => {
  const app = requireToolDep('express')();
  let rejectEvidence = false;
  registerSemanticQaRoutes(app, { basePath: '/api', deps: {
    database: {
      getIndexStatus: async () => ({ initialized: true, recordCount: 2, corpus: {
        embeddingModel: 'bge-m3', embeddingModelDigest: 'test', embeddingDimension: 2,
        embeddingFormatVersion: core.GENERIC_EMBEDDING_FORMAT, retrievalSchemaVersion: core.RETRIEVAL_SCHEMA_VERSION,
      } }),
      searchPassageIndex: async () => ({ hybrid: true, rows: [
        row('weak', 'A weak but paired reply.', 0.1, { discoveryExact: true, discoveryAnswerUnitId: 'weak:answer:1' }),
        row('strong', 'A complete independently relevant answer.', 0.9, { storyComplete: !rejectEvidence }),
      ] }),
    },
    ollama: { embedTexts: async () => [[1, 0]], getModelIdentity: async () => ({ digest: 'test' }) },
    syncManager: {},
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    async function search() {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          indexConnection: { host: 'mock', user: 'reader', database: 'mock' },
          question: 'How should I act?', topK: 1, threshold: 0.45, summary: { mode: 'standard', enabled: true },
        }),
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    const accepted = await search();
    assert.equal(accepted.acceptedMatch.sourceId, 'strong');
    assert.equal(accepted.summary.status, 'ready');
    rejectEvidence = true;
    const rejected = await search();
    assert.equal(rejected.strongMatch, false);
    assert.equal(rejected.acceptedMatch, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('regression: answerable spiritual paraphrase with low literal token overlap is admitted via discovery grounding', () => {
  const query = 'What is the spiritual damage caused by engaging in illicit affairs and breaking marriage vows?';
  const rows = [
    row('discourse:2607', 'Without the dropout of other worldly bonds, if the bond with God is formed, it is illicit connection according to worldly ethics.', 0.5568, {
      discoverySimilarity: 0.6482,
      discoveryExact: false,
      lexicalScore: 0,
      question: 'Illicit connection and bonds',
      author: 'Swami',
    }),
  ];
  const ranked = core.rerankPassageMatches(rows, query, 5, 0.49);
  assert.equal(ranked[0].sourceId, 'discourse:2607');
  assert.ok(ranked[0].relevanceScore >= 0.55, `Relevance score was ${ranked[0].relevanceScore}, expected >= 0.55`);
  const response = core.buildSearchResponse(ranked, 0.49, query);
  assert.equal(response.strongMatch, true, 'Answerable paraphrase must be admitted as strong match');
  assert.equal(response.acceptedMatch.sourceId, 'discourse:2607');
});

test('regression: physical facility/device query sharing spiritual vocabulary is rejected as unsupported task', () => {
  const query = 'Can an oil lamp illuminate an entire football stadium at night?';
  const rows = [
    row('discourse:533', 'The oil lamp is lit to remind us of the divine light within. Just as the lamp dispels darkness, knowledge illuminates the soul.', 0.53, {
      discoverySimilarity: 0.50,
      discoveryExact: false,
      lexicalScore: 0.1,
      question: 'Spiritual significance of oil lamps',
      author: 'Swami',
    }),
  ];
  const ranked = core.rerankPassageMatches(rows, query, 5, 0.49);
  assert.equal(ranked[0].rankingSignals.taskSupported, false, 'Lighting a football stadium is not supported by spiritual lamp passage');
  const response = core.buildSearchResponse(ranked, 0.49, query);
  assert.equal(response.strongMatch, false, 'Physical stadium lighting request must abstain / reject strongMatch');
  assert.equal(response.acceptedMatch, undefined);
});
