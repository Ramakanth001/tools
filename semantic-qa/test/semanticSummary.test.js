const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SUMMARY_MODE,
  buildSemanticSummary,
  filterRelevantMatches,
  selectGroundedEvidence,
  splitAnswerForIndex,
  splitAnswerIntoPassages,
} = require('../src/semanticSummary');

test('sentence passages are Unicode-aware, bounded, and exact source slices', () => {
  const answer = 'ആദ്യ വാക്യം പൂർണ്ണമാണ്. రెండవ వాక్యం కూడా పూర్తిగా ఉంది. A final English sentence remains unchanged.';
  const passages = splitAnswerIntoPassages(answer, { maxCharacters: 50, maxPassages: 20 });
  assert.ok(passages.length >= 2);
  for (const passage of passages) {
    assert.equal(answer.slice(passage.start, passage.end), passage.text);
    assert.ok(passage.text.length <= 50);
  }
});

test('legacy index segmentation retains every dense paragraph', () => {
  const answer = Array.from({ length: 40 }, (_, index) => `Sentence ${index + 1} is exact.`).join(' ');
  const passages = splitAnswerForIndex(answer, { maxPassages: 256 });
  assert.equal(passages.map((item) => item.text).join(' ').replace(/\s+/gu, ' '), answer.replace(/\s+/gu, ' '));
});

test('relevance admission requires both threshold and dense passage meaning', () => {
  const admitted = filterRelevantMatches([
    { sourceId: 'good', relevanceScore: 0.6, similarity: 0.5 },
    { sourceId: 'lexical-only', relevanceScore: 0.8, similarity: 0.1 },
    { sourceId: 'weak', relevanceScore: 0.2, similarity: 0.9 },
  ], 0.49);
  assert.deepEqual(admitted.map((item) => item.sourceId), ['good']);
});

test('quoted phrase selection excludes a semantically nearby but differently worded teaching', () => {
  const exact = 'The Light is in Me means qualified monism.';
  const nearby = 'I am the Light means monism.';
  const selected = selectGroundedEvidence([
    { sourceId: 'nearby', text: nearby, semanticSimilarity: 0.9, recordRelevance: 0.9 },
    { sourceId: 'exact', text: exact, semanticSimilarity: 0.7, recordRelevance: 0.7 },
  ], 5, 'What does “The Light is in Me” mean?');
  assert.deepEqual(selected.map((item) => item.sourceId), ['exact']);
});

test('verbatim selection never calls a generation model and returns exact stored spans', async () => {
  const answer = 'Do your duty without attachment. Keep the result with God.';
  let generationCalls = 0;
  const result = await buildSemanticSummary({
    question: 'How should I work?',
    matches: [{
      sourceId: 'discourse:1', question: 'Duty', answer, relevanceScore: 0.72, similarity: 0.66,
      matchedPassages: [{
        text: answer, citationText: answer, start: 0, end: answer.length, citationStart: 0, citationEnd: answer.length,
        semanticSimilarity: 0.66, answerUnitId: 'discourse:1:teaching:1', author: 'Swami', unitKind: 'swami_teaching',
        contextComplete: true, storyComplete: true,
      }],
    }],
    threshold: 0.49,
    maxLines: 3,
    generateAnswer: async () => { generationCalls += 1; },
  });
  assert.equal(generationCalls, 0);
  assert.equal(result.summary.mode, SUMMARY_MODE);
  assert.equal(result.summary.status, 'ready');
  assert.equal(result.summary.text, answer);
  assert.equal(result.summary.evidence[0].text, answer);
  assert.equal(answer.slice(result.summary.evidence[0].start, result.summary.evidence[0].end), result.summary.evidence[0].text);
});

test('an exact structured Q&A reply precedes denser semantic neighbors', async () => {
  const directAnswer = 'Make your best effort and do not ask God to violate His rules.';
  const neighborAnswer = 'A nearby teaching with a higher passage cosine remains secondary.';
  const result = await buildSemanticSummary({
    question: 'Should we ask the Lord for help?',
    threshold: 0.49,
    maxLines: 2,
    matches: [
      {
        sourceId: 'qa:101', question: 'Should we ask the Lord for help?', answer: directAnswer,
        relevanceScore: 1, similarity: 0.38, rankingSignals: { exactQaDiscovery: true },
        matchedPassages: [{
          text: directAnswer, citationText: directAnswer, start: 0, end: directAnswer.length,
          citationStart: 0, citationEnd: directAnswer.length, semanticSimilarity: 0.38,
          author: 'Swami', unitKind: 'swami_reply', contextComplete: true, storyComplete: true,
        }],
      },
      {
        sourceId: 'discourse:1', question: 'A related subject', answer: neighborAnswer,
        relevanceScore: 0.72, similarity: 0.72,
        matchedPassages: [{
          text: neighborAnswer, citationText: neighborAnswer, start: 0, end: neighborAnswer.length,
          citationStart: 0, citationEnd: neighborAnswer.length, semanticSimilarity: 0.72,
          author: 'Swami', unitKind: 'swami_teaching', contextComplete: true, storyComplete: true,
        }],
      },
    ],
  });
  assert.equal(result.summary.status, 'ready');
  assert.equal(result.summary.answerStatus, 'direct');
  assert.equal(result.summary.evidence[0].sourceId, 'qa:101');
  assert.equal(result.summary.evidence[0].text, directAnswer);
  assert.equal(result.summary.evidence[0].exactQaDiscovery, undefined);
});

test('invalid offsets cannot become displayed teaching text', async () => {
  const answer = 'The stored teaching remains exact.';
  const result = await buildSemanticSummary({
    question: 'Question', threshold: 0.49,
    matches: [{
      sourceId: 'bad-offset', answer, relevanceScore: 0.7, similarity: 0.7,
      matchedPassages: [{ text: answer, start: 1, end: answer.length, semanticSimilarity: 0.7, author: 'Swami' }],
    }],
  });
  assert.equal(result.summary.status, 'not_available');
  assert.equal(result.summary.reason, 'no_semantically_relevant_passages');
});

test('non-Swami, context-incomplete, and story-incomplete passages are excluded', async () => {
  const cases = [
    { author: 'Devotee', contextComplete: true, storyComplete: true },
    { author: 'Swami', contextComplete: false, storyComplete: true },
    { author: 'Swami', contextComplete: true, storyComplete: false },
  ];
  for (const [index, flags] of cases.entries()) {
    const answer = `Exact passage ${index}.`;
    const result = await buildSemanticSummary({
      question: 'Question', threshold: 0.49,
      matches: [{ sourceId: `source-${index}`, answer, relevanceScore: 0.7, similarity: 0.7,
        matchedPassages: [{ text: answer, start: 0, end: answer.length, semanticSimilarity: 0.7, ...flags }] }],
    });
    assert.equal(result.summary.status, 'not_available');
    assert.equal(result.summary.reason, 'no_complete_swami_evidence');
  }
});

test('evidence pooling uses distinct sources only', () => {
  const selected = selectGroundedEvidence([
    { sourceId: 'a', text: 'First A', semanticSimilarity: 0.8, recordRelevance: 0.8 },
    { sourceId: 'a', text: 'Second A', semanticSimilarity: 0.7, recordRelevance: 0.8 },
    { sourceId: 'b', text: 'First B', semanticSimilarity: 0.6, recordRelevance: 0.6 },
  ], 15);
  assert.deepEqual(selected.map((item) => item.sourceId), ['a', 'b']);
});
