const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSemanticSummary,
  buildEvidencePassages,
  filterRelevantMatches,
  splitAnswerForIndex,
  splitAnswerIntoPassages,
  selectGroundedEvidence,
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

test('index segmentation retains every paragraph in sentence-dense answers', () => {
  const answer = Array.from({ length: 90 }, (_, index) => `Paragraph ${index + 1} contains distinct evidence.`).join('\n\n');
  const passages = splitAnswerForIndex(answer, { maxPassages: 256 });
  assert.equal(passages.length, 90);
  assert.equal(passages[0].text, 'Paragraph 1 contains distinct evidence.');
  assert.equal(passages.at(-1).text, 'Paragraph 90 contains distinct evidence.');
});

test('short standalone answer lines are merged into context instead of discarded', () => {
  const answer = 'Yes.\n\nThis longer paragraph explains why the short reply is correct and provides enough semantic context.';
  const passages = splitAnswerForIndex(answer, { maxPassages: 256 });
  assert.ok(passages.some((passage) => passage.text.includes('Yes.')));
  assert.ok(passages.some((passage) => passage.text.includes('longer paragraph explains why')));
  for (const passage of passages) assert.equal(answer.slice(passage.start, passage.end).trim(), passage.text);
});

test('a later replied marker never discards substantive answer paragraphs', () => {
  const answer = 'This substantive opening discusses a question in detail. Later, Jesus answered: the teaching continues here.';
  const [passage] = splitAnswerForIndex(answer, { maxPassages: 256 });
  assert.match(passage.text, /^This substantive opening/u);
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
  assert.doesNotMatch(passage.text, /devotee asked/u);
});

test('semantic summary synthesizes only from accepted indexed answer passages', async () => {
  const matches = [
    {
      sourceId: 'a',
      question: 'How is service practiced?',
      answer: 'Service is practiced through useful action without seeking a reward.',
      relevanceScore: 0.76,
      similarity: 0.62,
      relevanceRank: 1,
      matchedPassages: [{ text: 'Service is practiced through useful action without seeking a reward.', start: 0, end: 63, semanticSimilarity: 0.62 }],
    },
    {
      sourceId: 'b',
      question: 'What attitude supports service?',
      answer: 'A sincere attitude keeps the attention on helping rather than recognition.',
      relevanceScore: 0.68,
      similarity: 0.58,
      relevanceRank: 2,
      matchedPassages: [{ text: 'A sincere attitude keeps the attention on helping rather than recognition.', start: 0, end: 74, semanticSimilarity: 0.58 }],
    },
    {
      sourceId: 'weak',
      question: 'Unrelated title',
      answer: 'This below-threshold record must never enter the summary embedding input.',
      relevanceScore: 0.30,
      similarity: 0.70,
      relevanceRank: 3,
      matchedPassages: [{ text: 'This below-threshold record must never enter the summary input.', start: 0, end: 61, semanticSimilarity: 0.70 }],
    },
  ];
  let generationInput;
  const result = await buildSemanticSummary({
    question: 'How can I serve without seeking recognition?',
    matches,
    threshold: 0.49,
    maxRecords: 15,
    maxLines: 3,
    baseUrl: 'http://127.0.0.1:11434',
    model: 'gemma3:4b',
    generateAnswer: async (input) => {
      generationInput = input;
      return {
        answer: 'Serve through useful action, focusing on helping rather than recognition or reward.',
        evidenceNumbers: [1, 2],
      };
    },
  });

  assert.equal(result.summary.status, 'ready');
  assert.deepEqual(result.relevantMatches.map((match) => match.sourceId), ['a', 'b']);
  assert.ok(generationInput.evidence.every((item) => !item.text.includes('below-threshold')));
  assert.match(result.summary.text, /focusing on helping/);
  assert.deepEqual(new Set(result.summary.evidence.map((item) => item.sourceId)), new Set(['a', 'b']));
  for (const evidence of result.summary.evidence) {
    const source = matches.find((match) => match.sourceId === evidence.sourceId);
    assert.ok(source.answer.includes(evidence.text));
  }
});

test('summary evidence expands one indexed passage on each side to preserve its meaning', async () => {
  const answer = [
    'The first statement means dualism. It describes separation from God. It is the first stage.',
    'The Light is in Me indicates the second stage. The second stage is qualified monism between dualism and monism. It is the intermediate relationship.',
    'I am the Light indicates monism.',
  ].join(' ');
  const passages = splitAnswerForIndex(answer, { maxPassages: 256 });
  let generationEvidence;
  const result = await buildSemanticSummary({
    question: 'What does "The Light is in Me" mean?',
    matches: [{
      sourceId: 'stages',
      question: 'Three statements',
      answer,
      relevanceScore: 0.70,
      similarity: 0.65,
      matchedPassages: [{ ...passages[1], semanticSimilarity: 0.65 }],
    }],
    threshold: 0.49,
    generateAnswer: async ({ evidence }) => {
      generationEvidence = evidence;
      return { answer: 'It means qualified monism, the intermediate stage.', evidenceNumbers: [1] };
    },
  });
  assert.equal(result.summary.status, 'ready');
  assert.match(generationEvidence[0].text, /first statement means dualism/u);
  assert.match(generationEvidence[0].text, /Light is in Me indicates the second stage/u);
  assert.match(generationEvidence[0].text, /second stage is qualified monism/u);
  assert.match(generationEvidence[0].text, /I am the Light indicates monism/u);
  assert.ok(answer.includes(generationEvidence[0].text));
});

test('summary context never crosses into an unrelated paragraph', async () => {
  const unrelated = 'This separate paragraph discusses exam preparation and receiving help.';
  const exact = 'The Light is in Me means qualified monism, the intermediate stage.';
  const answer = `${unrelated}\n\n${exact}`;
  const passages = splitAnswerForIndex(answer, { maxPassages: 256 });
  let generationEvidence;
  await buildSemanticSummary({
    question: 'What does "The Light is in Me" mean?',
    matches: [{
      sourceId: 'separate-paragraphs', question: 'Two topics', answer,
      relevanceScore: 0.70, similarity: 0.65,
      matchedPassages: [{ ...passages[1], semanticSimilarity: 0.65 }],
    }],
    threshold: 0.49,
    generateAnswer: async ({ evidence }) => {
      generationEvidence = evidence;
      return { answer: 'It means qualified monism.', evidenceNumbers: [1] };
    },
  });
  assert.equal(generationEvidence[0].text, exact);
  assert.doesNotMatch(generationEvidence[0].text, /exam preparation/u);
});

test('an explicit quoted phrase excludes semantically nearby statements with different wording', async () => {
  let generationEvidence;
  const exact = 'The Light is in Me means the intermediate stage of qualified monism.';
  const nearby = 'I am the Light means complete monism.';
  const result = await buildSemanticSummary({
    question: 'What does "The Light is in Me" mean?',
    matches: [
      {
        sourceId: 'nearby', question: 'Nearby phrase', answer: nearby,
        relevanceScore: 0.80, similarity: 0.80,
        matchedPassages: [{ text: nearby, start: 0, end: nearby.length, semanticSimilarity: 0.80 }],
      },
      {
        sourceId: 'exact', question: 'Exact phrase', answer: exact,
        relevanceScore: 0.70, similarity: 0.70,
        matchedPassages: [{ text: exact, start: 0, end: exact.length, semanticSimilarity: 0.70 }],
      },
    ],
    threshold: 0.49,
    generateAnswer: async ({ evidence }) => {
      generationEvidence = evidence;
      return { answer: 'It means qualified monism.', evidenceNumbers: [1] };
    },
  });
  assert.equal(result.summary.status, 'ready');
  assert.deepEqual(generationEvidence.map((item) => item.sourceId), ['exact']);
  assert.deepEqual(result.relevantMatches.map((item) => item.sourceId), ['exact']);
});

test('an unquoted saying phrase excludes a nearby statement with reversed word order', async () => {
  let generationEvidence;
  const exact = 'The Light is in Me means the intermediate stage of qualified monism.';
  const nearby = 'I am the Light means complete monism.';
  const result = await buildSemanticSummary({
    question: 'What is the meaning of Jesus saying The light is in me?',
    matches: [
      { sourceId: 'nearby', answer: nearby, relevanceScore: 0.80, similarity: 0.80, matchedPassages: [{ text: nearby, start: 0, end: nearby.length, semanticSimilarity: 0.80 }] },
      { sourceId: 'exact', answer: exact, relevanceScore: 0.70, similarity: 0.70, matchedPassages: [{ text: exact, start: 0, end: exact.length, semanticSimilarity: 0.70 }] },
    ],
    threshold: 0.49,
    generateAnswer: async ({ evidence }) => { generationEvidence = evidence; return { answer: 'It means qualified monism.', evidenceNumbers: [1] }; },
  });
  assert.equal(result.summary.status, 'ready');
  assert.deepEqual(generationEvidence.map((item) => item.sourceId), ['exact']);
});

test('quoted synthesis prefers a direct same-sentence definition over an ambiguous mention', async () => {
  let generationEvidence;
  const direct = 'The Light is in Me (qualified monism between dualism and monism).';
  const ambiguous = 'The second stage is internal worship. It is indicated by “The Light is in Me”. The next stage is monism.';
  await buildSemanticSummary({
    question: 'What does "The Light is in Me" mean?',
    matches: [
      {
        sourceId: 'ambiguous', answer: ambiguous, relevanceScore: 0.75, similarity: 0.75,
        matchedPassages: [{ text: ambiguous, start: 0, end: ambiguous.length, semanticSimilarity: 0.75 }],
      },
      {
        sourceId: 'direct', answer: direct, relevanceScore: 0.60, similarity: 0.60,
        matchedPassages: [{ text: direct, start: 0, end: direct.length, semanticSimilarity: 0.60 }],
      },
    ],
    threshold: 0.49,
    generateAnswer: async ({ evidence }) => {
      generationEvidence = evidence;
      return { answer: 'It means qualified monism.', evidenceNumbers: [1] };
    },
  });
  assert.deepEqual(generationEvidence.map((item) => item.sourceId), ['direct']);
});

test('summary work is skipped when no record independently passes relevance', async () => {
  let calls = 0;
  const result = await buildSemanticSummary({
    question: 'Unanswerable?',
    matches: [{ sourceId: 'weak', answer: 'A sufficiently long but irrelevant answer.', relevanceScore: 0.2, similarity: 0.8 }],
    threshold: 0.49,
    generateAnswer: async () => { calls += 1; return { answer: 'no', evidenceNumbers: [1] }; },
  });
  assert.equal(calls, 0);
  assert.equal(result.summary.status, 'not_available');
  assert.equal(result.summary.reason, 'no_relevant_records');
  assert.deepEqual(result.relevantMatches, []);
});

test('summary rejects threshold-passing passages that do not answer the exact intent', async () => {
  const answer = 'An oil lamp was historically used to provide light.';
  const result = await buildSemanticSummary({
    question: 'Can an oil lamp heat a house?',
    matches: [{
      sourceId: 'lamp-light', question: 'Oil lamps', answer,
      relevanceScore: 0.62, similarity: 0.60,
      matchedPassages: [{ text: answer, start: 0, end: answer.length, semanticSimilarity: 0.60 }],
    }],
    threshold: 0.49,
    generateAnswer: async () => ({ answerable: false, answer: '', evidenceNumbers: [] }),
  });
  assert.equal(result.summary.status, 'not_available');
  assert.equal(result.summary.reason, 'no_answerable_evidence');
  assert.deepEqual(result.relevantMatches, []);
});

test('grounded synthesis can pool one accepted passage from each of fifteen records', async () => {
  const matches = Array.from({ length: 15 }, (_, index) => ({
    sourceId: `source-${index + 1}`,
    question: `Stored title ${index + 1}`,
    answer: `Independent supporting passage ${index + 1}.`,
    relevanceScore: 0.62,
    similarity: 0.60,
    relevanceRank: index + 1,
    matchedPassages: [{
      text: `Independent supporting passage ${index + 1}.`,
      start: 0,
      end: `Independent supporting passage ${index + 1}.`.length,
      semanticSimilarity: 0.60,
    }],
  }));
  let evidenceCount = 0;
  const result = await buildSemanticSummary({
    question: 'What do all accepted records collectively explain?',
    matches,
    threshold: 0.49,
    maxRecords: 15,
    maxLines: 3,
    model: 'gemma3:4b',
    generateAnswer: async ({ evidence }) => {
      evidenceCount = evidence.length;
      return { answer: 'A concise pooled answer.', evidenceNumbers: [1, 15] };
    },
  });
  assert.equal(evidenceCount, 15);
  assert.equal(result.relevantMatches.length, 15);
  assert.deepEqual(result.summary.evidence.map((item) => item.sourceId), ['source-1', 'source-15']);
  assert.deepEqual(result.summary.evidence.map((item) => item.evidenceNumber), [1, 15]);
});

test('evidence pooling never fills unused slots with duplicate source records', () => {
  const selected = selectGroundedEvidence([
    { sourceId: 'a', text: 'First A', semanticSimilarity: 0.8, recordRelevance: 0.8 },
    { sourceId: 'a', text: 'Second A', semanticSimilarity: 0.7, recordRelevance: 0.8 },
    { sourceId: 'b', text: 'First B', semanticSimilarity: 0.6, recordRelevance: 0.6 },
  ], 15);
  assert.deepEqual(selected.map((item) => item.sourceId), ['a', 'b']);
});
