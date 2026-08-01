const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSemanticSummary,
  buildEvidencePassages,
  cosineSimilarity,
  filterRelevantMatches,
  selectDiverseEvidence,
  splitAnswerIntoPassages,
} = require('../src/semanticSummary');

test('answer segmentation is Unicode-aware, bounded, and keeps exact source substrings', () => {
  const answer = 'First supporting sentence. Second supporting sentence.\n\nമൂന്നാമത്തെ പ്രസക്തമായ വാക്യം. നാലാമത്തെ വാക്യം.';
  const passages = splitAnswerIntoPassages(answer, { maxCharacters: 55, maxPassages: 10 });
  assert.ok(passages.length >= 2);
  for (const passage of passages) {
    assert.ok(answer.includes(passage.text));
    assert.ok(passage.text.length <= 55);
    assert.equal(answer.slice(passage.start, passage.end), passage.text);
  }
});

test('relevant record admission requires both the existing threshold and dense meaning similarity', () => {
  const matches = [
    { sourceId: 'accepted', relevanceScore: 0.72, similarity: 0.61 },
    { sourceId: 'lexical-only', relevanceScore: 0.80, similarity: 0.12 },
    { sourceId: 'below-threshold', relevanceScore: 0.48, similarity: 0.70 },
  ];
  assert.deepEqual(
    filterRelevantMatches(matches, 0.49).map((match) => match.sourceId),
    ['accepted'],
  );
});

test('evidence starts at an explicit answer boundary and excludes stored question preamble', () => {
  const [passage] = buildEvidencePassages([{
    sourceId: 'lamp',
    question: 'Should an oil lamp be used?',
    answer: '[A discussion took place.] [A devotee asked whether an oil lamp is needed?] Swāmi replied: Neither an electric lamp nor an oil lamp is needed for God. The lamp is only for your convenience.',
    relevanceScore: 0.70,
    similarity: 0.60,
  }]);
  assert.match(passage.text, /^Swāmi replied:/u);
  assert.equal(passage.answerCue, true);
  assert.doesNotMatch(passage.text, /devotee asked/u);
});

test('diverse semantic evidence prefers a different source over a redundant line', () => {
  const selected = selectDiverseEvidence([
    { sourceId: 'a', text: 'Primary idea.', semanticSimilarity: 0.95, recordRelevance: 0.8, vector: [1, 0] },
    { sourceId: 'a', text: 'Near duplicate.', semanticSimilarity: 0.94, recordRelevance: 0.8, vector: [0.99, 0.01] },
    { sourceId: 'b', text: 'Complementary idea.', semanticSimilarity: 0.90, recordRelevance: 0.7, vector: [0, 1] },
  ], 2);
  assert.deepEqual(selected.map((item) => item.sourceId), ['a', 'b']);
});

test('a semantically relevant explicit answer is preferred over a rhetorical support question', () => {
  const selected = selectDiverseEvidence([
    { sourceId: 'lamp', text: 'Why burn the oil?', semanticSimilarity: 0.53, recordRelevance: 0.7, vector: [1, 0], answerCue: false },
    { sourceId: 'lamp', text: 'Swāmi replied: No oil lamp is needed.', semanticSimilarity: 0.39, recordRelevance: 0.7, vector: [0.8, 0.2], answerCue: true },
  ], 1);
  assert.equal(selected[0].text, 'Swāmi replied: No oil lamp is needed.');
});

test('semantic summary embeds only accepted answers and returns verbatim cited evidence', async () => {
  const matches = [
    {
      sourceId: 'a',
      question: 'How is service practiced?',
      answer: 'Service is practiced through useful action without seeking a reward.',
      relevanceScore: 0.76,
      similarity: 0.62,
      relevanceRank: 1,
    },
    {
      sourceId: 'b',
      question: 'What attitude supports service?',
      answer: 'A sincere attitude keeps the attention on helping rather than recognition.',
      relevanceScore: 0.68,
      similarity: 0.58,
      relevanceRank: 2,
    },
    {
      sourceId: 'weak',
      question: 'Unrelated title',
      answer: 'This below-threshold record must never enter the summary embedding input.',
      relevanceScore: 0.30,
      similarity: 0.70,
      relevanceRank: 3,
    },
  ];
  const embeddedInputs = [];
  const result = await buildSemanticSummary({
    queryVector: [1, 0, 0],
    matches,
    threshold: 0.49,
    maxRecords: 15,
    maxLines: 3,
    baseUrl: 'http://127.0.0.1:11434',
    model: 'embeddinggemma',
    formatVersion: 'embeddinggemma-asymmetric-v3',
    embedTexts: async ({ texts }) => {
      embeddedInputs.push(...texts);
      return texts.map((text) => text.includes('sincere attitude') ? [0.92, 0.08, 0] : [1, 0, 0]);
    },
  });

  assert.equal(result.summary.status, 'ready');
  assert.deepEqual(result.relevantMatches.map((match) => match.sourceId), ['a', 'b']);
  assert.ok(embeddedInputs.every((text) => !text.includes('below-threshold')));
  assert.deepEqual(new Set(result.summary.evidence.map((item) => item.sourceId)), new Set(['a', 'b']));
  for (const evidence of result.summary.evidence) {
    const source = matches.find((match) => match.sourceId === evidence.sourceId);
    assert.ok(source.answer.includes(evidence.text));
  }
});

test('summary work is skipped when no record independently passes relevance', async () => {
  let calls = 0;
  const result = await buildSemanticSummary({
    queryVector: [1, 0],
    matches: [{ sourceId: 'weak', answer: 'A sufficiently long but irrelevant answer.', relevanceScore: 0.2, similarity: 0.8 }],
    threshold: 0.49,
    embedTexts: async () => { calls += 1; return []; },
  });
  assert.equal(calls, 0);
  assert.equal(result.summary.status, 'not_available');
  assert.equal(result.summary.reason, 'no_relevant_records');
  assert.deepEqual(result.relevantMatches, []);
});

test('cosine validation rejects incompatible or invalid vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.throws(() => cosineSimilarity([1], [1, 2]), /incompatible dimensions/);
  assert.throws(() => cosineSimilarity([Number.NaN], [1]), /invalid value/);
});
