const test = require('node:test');
const assert = require('node:assert/strict');
const {
  augmentDeepSearchProbes,
  collectCandidateEvidence,
  createDeepSummaryManager,
  fuseMatches,
  isLiteralDirectQuestionMatch,
  selectAdjudicationUnits,
} = require('../src/deepSummaryManager');
const { sha256 } = require('../src/corpusStructure');

function match(sourceId, text, score = 0.7) {
  return {
    sourceId,
    sourceGroup: sourceId,
    question: `Title ${sourceId}`,
    relevanceScore: score,
    similarity: score,
    matchedPassages: [{
      text,
      citationText: text,
      start: 0,
      end: text.length,
      citationStart: 0,
      citationEnd: text.length,
      answerUnitId: `${sourceId}:teaching:1`,
      author: 'Swami',
      unitKind: 'swami_teaching',
      contextComplete: true,
      storyComplete: true,
      semanticSimilarity: score,
    }],
  };
}

function unit(sourceId, text, associatedQuestion = '') {
  return {
    sourceId,
    answerUnitId: `${sourceId}:teaching:1`,
    title: `Title ${sourceId}`,
    author: 'Swami',
    unitKind: 'swami_teaching',
    associatedQuestion,
    start: 0,
    end: text.length,
    text,
    displayText: text,
    contentHash: sha256(text),
    contextComplete: true,
  };
}

async function waitForTerminal(manager, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = manager.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Deep Search did not finish');
}

function managerFor(classification = 'governing_principle', overrides = {}) {
  return createDeepSummaryManager({
    requireThinking: async ({ model }) => ({ model, capabilities: ['thinking'] }),
    planProbes: async ({ question }) => [question, 'governing principle', 'qualification', 'counter teaching'],
    adjudicate: async ({ units, reviewer }) => units.map((item) => ({
      answerUnitId: item.answerUnitId,
      classification,
      cluster: 'Duty without attachment',
      relationship: `reviewer ${reviewer}`,
      contextComplete: true,
      storyComplete: true,
    })),
    ...overrides,
  });
}

test('candidate collection carries exact citation spans and role metadata', () => {
  const teaching = 'Do your duty without attachment.';
  const collected = collectCandidateEvidence([match('discourse:1', teaching)], { maxRecords: 60 });
  assert.equal(collected.evidence.length, 1);
  assert.equal(collected.evidence[0].text, teaching);
  assert.equal(collected.evidence[0].answerUnitId, 'discourse:1:teaching:1');
  assert.equal(collected.evidence[0].author, 'Swami');
});

test('career Deep Search adds focused fruit, interview, and peaceful-life probes', () => {
  const probes = augmentDeepSearchProbes(
    'Can I ask God for a promotion in my job?',
    ['What governs prayer for professional success?'],
  );
  assert.equal(probes[0], 'Can I ask God for a promotion in my job?');
  assert.ok(probes.some((probe) => /job interview/u.test(probe)));
  assert.ok(probes.some((probe) => /practical worldly fruit/u.test(probe)));
  assert.ok(probes.some((probe) => /peaceful worldly life/u.test(probe)));
  assert.ok(probes.length <= 6);
});

test('multi-probe fusion reserves top candidates from an otherwise outvoted probe', () => {
  const fused = fuseMatches([
    [match('common', 'Common'), match('probe-specific', 'Specific'), match('tail-a', 'Tail A')],
    [match('common', 'Common'), match('other', 'Other'), match('tail-b', 'Tail B')],
  ], 4);
  assert.ok(fused.some((item) => item.sourceId === 'probe-specific'));
  assert.equal(fused.find((item) => item.sourceId === 'probe-specific').bestProbeRank, 2);
});

test('bounded adjudication selects only retrieved complete units within its character budget', () => {
  const units = [unit('first', 'a'.repeat(2000)), unit('second', 'b'.repeat(3000)), unit('unretrieved', 'c')];
  const evidence = [
    { answerUnitId: 'first:teaching:1', bestProbeRank: 1, matchedProbeCount: 2, relevanceScore: 0.8 },
    { answerUnitId: 'second:teaching:1', bestProbeRank: 2, matchedProbeCount: 1, relevanceScore: 0.7 },
  ];
  const selected = selectAdjudicationUnits(units, evidence, 3000);
  assert.deepEqual(selected.units.map((item) => item.sourceId), ['first']);
  assert.equal(selected.candidates, 2);
  assert.ok(selected.characters <= 3000);
});

test('literal direct status rejects a nearby interview teaching for a promotion question', () => {
  assert.equal(isLiteralDirectQuestionMatch(
    'I want promotion in my job can I ask God to give me that boon?',
    'What should a devotee pray before attending an interview, test, or medical surgery?',
  ), false);
  assert.equal(isLiteralDirectQuestionMatch(
    'Can I ask God for a job promotion?',
    'Can I ask God for a job promotion?',
  ), true);
});

test('Deep Search uses multiple probes, two adjudications, and returns only verbatim related teachings', async () => {
  const teaching = 'Do your duty without attachment.';
  const calls = { probes: [], reviewers: [] };
  const manager = managerFor('governing_principle', {
    planProbes: async ({ question }) => [question, 'duty', 'worldly success', 'qualification'],
    adjudicate: async ({ units, reviewer }) => {
      calls.reviewers.push(reviewer);
      return units.map((item) => ({ answerUnitId: item.answerUnitId, classification: 'governing_principle',
        cluster: 'Duty without attachment', relationship: 'It governs the requested situation.', contextComplete: true, storyComplete: true }));
    },
  });
  const job = manager.start({
    question: 'How should I seek promotion?', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:1', teaching)],
    retrieveProbe: async (probe) => { calls.probes.push(probe); return [match('discourse:1', teaching)]; },
    readAnswerUnits: async () => [unit('discourse:1', teaching)],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.answerStatus, 'related_teachings');
  assert.deepEqual(completed.result.paragraphs.map((item) => item.text), [teaching]);
  assert.equal(completed.result.evidence[0].text, teaching);
  assert.equal(completed.result.audit.probes, 6);
  assert.equal(calls.probes.length, 6);
  assert.deepEqual(calls.reviewers, [1, 2]);
  assert.equal(completed.parallelism, 1);
  assert.equal(completed.estimatedTotalSeconds, null);
});

test('a direct classification produces the direct outcome without generated teaching prose', async () => {
  const teaching = 'Promotion is not the measure of spiritual progress.';
  const manager = managerFor('direct_answer');
  const job = manager.start({
    question: 'Is promotion spiritual progress?', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:2', teaching)],
    readAnswerUnits: async () => [unit('discourse:2', teaching, 'Is promotion spiritual progress?')],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.result.answerStatus, 'direct');
  assert.equal(completed.result.paragraphs[0].text, teaching);
});

test('a model direct classification becomes related when the stored question is not literal', async () => {
  const teaching = 'Love to God without aspiration for any fruit can come only through strong effort.';
  const manager = managerFor('direct_answer');
  const job = manager.start({
    question: 'Can I ask God for a job promotion?', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:2296', teaching)],
    readAnswerUnits: async () => [unit(
      'discourse:2296',
      teaching,
      'What should a devotee pray before an interview, test, or medical surgery?',
    )],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.result.answerStatus, 'related_teachings');
  assert.equal(completed.result.evidence[0].classification, 'governing_principle');
});

test('disagreements use a third adjudication and irrelevant evidence can be discarded', async () => {
  const teaching = 'A nearby but non-answering passage.';
  const reviewers = [];
  const manager = managerFor('irrelevant', {
    adjudicate: async ({ units, reviewer }) => {
      reviewers.push(reviewer);
      const classification = reviewer === 1 ? 'governing_principle' : 'irrelevant';
      return units.map((item) => ({ answerUnitId: item.answerUnitId, classification,
        cluster: 'Nearby', relationship: '', contextComplete: true, storyComplete: true }));
    },
  });
  const job = manager.start({
    question: 'A different request', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:3', teaching)], readAnswerUnits: async () => [unit('discourse:3', teaching)],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.deepEqual(reviewers, [1, 2, 3]);
  assert.equal(completed.result.answerStatus, 'insufficient');
  assert.equal(completed.result.evidence.length, 0);
  assert.equal(completed.result.audit.disagreements, 1);
});

test('invalid offsets or hashes are rejected deterministically at final verification', async () => {
  const teaching = 'Exact source teaching.';
  const broken = { ...unit('discourse:4', teaching), displayText: 'Different source text.' };
  const manager = managerFor();
  const job = manager.start({
    question: 'Question', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:4', teaching)], readAnswerUnits: async () => [broken],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.result.answerStatus, 'insufficient');
  assert.equal(completed.result.audit.finalVerification, 0);
});

test('full answer units are adjudicated while the exact retrieved logical passage is displayed', async () => {
  const first = 'This opening paragraph supplies context.';
  const selected = 'Do your duty without attachment.';
  const displayText = `${first}\n\n${selected}`;
  const passageStart = displayText.indexOf(selected);
  const sourceMatch = match('discourse:5', selected);
  Object.assign(sourceMatch.matchedPassages[0], {
    start: passageStart,
    end: passageStart + selected.length,
    citationStart: passageStart,
    citationEnd: passageStart + selected.length,
  });
  const completeUnit = {
    ...unit('discourse:5', displayText),
    text: displayText,
    displayText,
    start: 0,
    end: displayText.length,
    contentHash: sha256(displayText),
  };
  const manager = managerFor();
  const job = manager.start({
    question: 'How should I work?', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [sourceMatch], readAnswerUnits: async () => [completeUnit],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.result.evidence[0].text, selected);
  assert.equal(completed.result.evidence[0].start, passageStart);
  assert.equal(completed.result.evidence[0].answerUnitHash, sha256(displayText));
});

test('model calls retry once and remain bounded', async () => {
  const teaching = 'A relevant exact teaching.';
  let attempts = 0;
  const manager = managerFor('governing_principle', {
    planProbes: async ({ question }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary malformed response');
      return [question];
    },
  });
  const job = manager.start({
    question: 'Question', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:6', teaching)], readAnswerUnits: async () => [unit('discourse:6', teaching)],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(attempts, 2);
  assert.ok(completed.logs.some((entry) => /retrying the same bounded model call/.test(entry)));
});

test('cancelling aborts an active thinking call', async () => {
  let aborted = false;
  const manager = createDeepSummaryManager({
    requireThinking: async () => ({ capabilities: ['thinking'] }),
    planProbes: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  });
  const job = manager.start({ question: 'Question', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434' });
  for (let attempt = 0; attempt < 100 && manager.get(job.id).activeRequests !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  manager.cancel(job.id);
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'cancelled');
  assert.equal(aborted, true);
});
