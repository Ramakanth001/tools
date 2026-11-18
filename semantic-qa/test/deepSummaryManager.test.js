const test = require('node:test');
const assert = require('node:assert/strict');
const {
  augmentDeepSearchProbes,
  collectCandidateEvidence,
  createDeepSummaryManager,
  fuseMatches,
  isLiteralDirectQuestionMatch,
  selectAdjudicationUnits,
  boundedReadingUnit,
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

test('long original-query answers remain readable with exact bounded paragraph offsets', () => {
  const text = `${'An unrelated paragraph. '.repeat(200)}\n\nDatta Swami is a spiritual teacher.\n\n${'More surrounding teaching. '.repeat(200)}`;
  const original = { ...unit('long', text, 'Who is Swami?'), start: 7, end: text.length + 7, displayText: `prefix ${text}` };
  const reading = boundedReadingUnit(original, 'Who is Datta Swami?', 1000);
  assert.equal(reading.text, 'Datta Swami is a spiritual teacher.');
  assert.equal(reading.displayText.slice(reading.start, reading.end), reading.text);
  assert.equal(reading.contentHash, sha256(reading.text));
  assert.equal(reading.readingTruncated, true);
  const selected = selectAdjudicationUnits([original, unit('other', 'Short unrelated paragraph.')], [
    { answerUnitId: original.answerUnitId, originalQueryRank: 1, bestProbeRank: 2 },
    { answerUnitId: 'other:teaching:1', bestProbeRank: 1 },
  ], 8000, 1, 'Who is Datta Swami?');
  assert.equal(selected.units[0].answerUnitId, original.answerUnitId);
});

test('augmentDeepSearchProbes deduplicates planned probes and rejects redundant query variations', () => {
  const probes = augmentDeepSearchProbes(
    'Can I ask God for a promotion in my job?',
    [
      'Can I ask God for a promotion in my job?',
      '  can i ask god for a promotion in my job?  ',
      'What governs prayer for professional success?',
      'Desireless devotion',
    ],
  );
  assert.equal(probes[0], 'Can I ask God for a promotion in my job?');
  assert.equal(probes[1], 'What governs prayer for professional success?');
  assert.equal(probes[2], 'Desireless devotion');
  assert.equal(probes.length, 3);
});
test('multi-unit discourse fusion preserves distinct answer units retrieved by separate probes', () => {
  const discourseId = 'discourse:42';
  const matchA = {
    sourceId: discourseId,
    sourceGroup: discourseId,
    question: 'Great Discourse',
    relevanceScore: 0.85,
    similarity: 0.85,
    matchedPassages: [{
      text: 'Teaching A: The soul cannot create the universe.',
      citationText: 'Teaching A: The soul cannot create the universe.',
      start: 0,
      end: 48,
      citationStart: 0,
      citationEnd: 48,
      answerUnitId: `${discourseId}:teaching:1`,
      author: 'Swami',
      unitKind: 'swami_teaching',
      contextComplete: true,
      storyComplete: true,
      semanticSimilarity: 0.85,
    }],
  };
  const matchB = {
    sourceId: discourseId,
    sourceGroup: discourseId,
    question: 'Great Discourse',
    relevanceScore: 0.88,
    similarity: 0.88,
    matchedPassages: [{
      text: 'Teaching B: Desireless service is the highest devotion.',
      citationText: 'Teaching B: Desireless service is the highest devotion.',
      start: 100,
      end: 155,
      citationStart: 100,
      citationEnd: 155,
      answerUnitId: `${discourseId}:teaching:2`,
      author: 'Swami',
      unitKind: 'swami_teaching',
      contextComplete: true,
      storyComplete: true,
      semanticSimilarity: 0.88,
    }],
  };

  const fused = fuseMatches([[matchA], [matchB]], 10);
  const collected = collectCandidateEvidence(fused, { maxRecords: 10 });
  const collectedUnitIds = collected.evidence.map((item) => item.answerUnitId);

  assert.ok(collectedUnitIds.includes(`${discourseId}:teaching:1`), 'Unit A must survive fusion');
  assert.ok(collectedUnitIds.includes(`${discourseId}:teaching:2`), 'Unit B must survive fusion');
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
  assert.equal(completed.result.audit.probes, 4);
  assert.equal(calls.probes.length, 3);
  assert.deepEqual(calls.reviewers, [1, 2]);
  assert.equal(completed.parallelism, 1);
  assert.equal(completed.estimatedTotalSeconds, null);
  assert.equal(completed.metrics.candidateFlow.answerUnitsAdjudicated, 1);
  assert.equal(completed.metrics.candidateFlow.finalVerified, 1);
  assert.equal(completed.metrics.probeRetrievals.length, 4);
  assert.ok(completed.metrics.modelCalls.every((call) => call.durationMs >= 0));
  assert.ok(completed.result.audit.performance.phases.adjudicate.durationMs >= 0);
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

test('a semantically direct answer retains direct status despite different source wording', async () => {
  const teaching = 'Datta Swami is a spiritual teacher.';
  const manager = managerFor('direct_answer');
  const job = manager.start({
    question: 'Who is Datta Swami?', model: 'qwen3:14b-q8_0', baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:2296', teaching)],
    readAnswerUnits: async () => [unit(
      'discourse:2296',
      teaching,
      'The identity of our teacher',
    )],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.result.answerStatus, 'direct');
  assert.equal(completed.result.evidence[0].classification, 'direct_answer');
});

test('mislabeled indexed devotee bylines are rejected before adjudication', async () => {
  const teaching = '[By Shri Veena Datta]\n\nMy personal experience with Swami.';
  const manager = managerFor('direct_answer', { adjudicate: async () => { throw new Error('must not adjudicate non-Swami text'); } });
  const job = manager.start({ question: 'Who is Swami?', model: 'qwen2.5:7b', matches: [match('discourse:4291', teaching)], readAnswerUnits: async () => [unit('discourse:4291', teaching)] });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.answerStatus, 'insufficient');
  assert.deepEqual(completed.result.evidence, []);
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

test('adaptive deliberation skips reviewer 2 when all units are governing principles', async () => {
  const teaching = 'Spiritual knowledge is the foundation of true devotion.';
  const reviewers = [];
  const manager = managerFor('governing_principle', {
    adjudicate: async ({ units, reviewer }) => {
      reviewers.push(reviewer);
      return units.map((u) => ({
        answerUnitId: u.answerUnitId,
        classification: 'governing_principle',
        cluster: 'Spiritual knowledge',
        relationship: 'Foundational principle',
        contextComplete: true,
        storyComplete: true,
      }));
    },
  });
  const job = manager.start({
    question: 'What is true devotion?',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    deliberation: 'adaptive',
    matches: [match('discourse:10', teaching)],
    readAnswerUnits: async () => [unit('discourse:10', teaching)],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.answerStatus, 'related_teachings');
  // Only Reviewer 1 should be invoked because no units are risky
  assert.deepEqual(reviewers, [1]);
});

test('adaptive deliberation runs targeted critique only for direct answer candidate units', async () => {
  const directTeaching = 'Swami says: God is unimaginable awareness.';
  const generalTeaching = 'Service without fruit is highest duty.';
  const reviewers = [];
  const critiqueUnits = [];

  const manager = managerFor('direct_answer', {
    adjudicate: async ({ units, reviewer }) => {
      reviewers.push(reviewer);
      if (reviewer === 2) {
        critiqueUnits.push(...units.map((u) => u.answerUnitId));
      }
      return units.map((u) => ({
        answerUnitId: u.answerUnitId,
        classification: u.answerUnitId.includes('direct') ? 'direct_answer' : 'governing_principle',
        cluster: 'Theology',
        relationship: 'Direct explanation',
        contextComplete: true,
        storyComplete: true,
      }));
    },
  });
  const job = manager.start({
    question: 'Who is God?',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    deliberation: 'adaptive',
    matches: [match('direct-doc', directTeaching), match('general-doc', generalTeaching)],
    readAnswerUnits: async () => [
      unit('direct-doc', directTeaching, 'Who is God?'),
      unit('general-doc', generalTeaching),
    ],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.answerStatus, 'direct');
  assert.deepEqual(reviewers, [1, 2]);
  // Critique pass should only contain the direct-doc unit, not general-doc
  assert.deepEqual(critiqueUnits, ['direct-doc:teaching:1']);
});

test('fast deliberation runs only a single adjudication pass', async () => {
  const teaching = 'Selfless sacrifice is highest.';
  const reviewers = [];
  const manager = managerFor('governing_principle', {
    adjudicate: async ({ units, reviewer }) => {
      reviewers.push(reviewer);
      return units.map((u) => ({
        answerUnitId: u.answerUnitId,
        classification: 'governing_principle',
        cluster: 'Sacrifice',
        relationship: 'Core teaching',
        contextComplete: true,
        storyComplete: true,
      }));
    },
  });
  const job = manager.start({
    question: 'What is sacrifice?',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    deliberation: 'fast',
    matches: [match('discourse:20', teaching)],
    readAnswerUnits: async () => [unit('discourse:20', teaching)],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(reviewers, [1]);
});

test('batched probe retrieval invokes retrieveProbes with all pending probes', async () => {
  const teaching = 'God fulfills true desires without aspiration for fruit.';
  const retrievedBatches = [];
  const manager = managerFor('governing_principle', {
    planProbes: async () => ['principle probe', 'qualification probe', 'counter probe'],
  });
  const job = manager.start({
    question: 'Can I pray for results?',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    matches: [match('discourse:30', teaching)],
    retrieveProbes: async (probes) => {
      retrievedBatches.push(probes);
      return probes.map(() => [match('discourse:30', teaching)]);
    },
    readAnswerUnits: async () => [unit('discourse:30', teaching)],
  });
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(retrievedBatches.length, 1);
  assert.deepEqual(retrievedBatches[0], ['principle probe', 'qualification probe', 'counter probe']);
});

test('global queue prevents competing Deep Search generations and records queue duration', async () => {
  let releaseJob1;
  const job1Blocker = new Promise((resolve) => { releaseJob1 = resolve; });
  const teaching = 'Truth alone triumphs.';
  const manager = managerFor('governing_principle', {
    planProbes: async ({ question }) => {
      if (question === 'Job 1') {
        await job1Blocker;
      }
      return [question];
    },
  });

  const job1 = manager.start({
    question: 'Job 1',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    matches: [match('doc1', teaching)],
    readAnswerUnits: async () => [unit('doc1', teaching)],
  });

  // Wait until Job 1 is running
  for (let i = 0; i < 100 && manager.get(job1.id).status !== 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(manager.get(job1.id).status, 'running');
  assert.equal(manager.getActiveJobId(), job1.id);

  // Start Job 2 while Job 1 is running
  const job2 = manager.start({
    question: 'Job 2',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    matches: [match('doc2', teaching)],
    readAnswerUnits: async () => [unit('doc2', teaching)],
  });

  // Job 2 must be queued, not running or competing
  assert.equal(manager.get(job2.id).status, 'queued');
  assert.equal(manager.get(job2.id).phase, 'queued');
  assert.equal(manager.get(job2.id).activeRequests, 0);
  assert.equal(manager.getQueueLength(), 1);

  // Unblock Job 1
  releaseJob1();
  const completed1 = await waitForTerminal(manager, job1.id);
  assert.equal(completed1.status, 'completed');
  assert.equal(completed1.terminationReason, 'completed');

  // Job 2 should now run and complete
  const completed2 = await waitForTerminal(manager, job2.id);
  assert.equal(completed2.status, 'completed');
  assert.equal(completed2.terminationReason, 'completed');
  assert.ok(completed2.metrics.queueDurationMs !== null && completed2.metrics.queueDurationMs >= 0);
  assert.equal(manager.getQueueLength(), 0);
});

test('cancelling a queued job removes it from the queue without starting generation', async () => {
  let releaseJob1;
  const job1Blocker = new Promise((resolve) => { releaseJob1 = resolve; });
  const teaching = 'Patience is virtue.';
  let job2Ran = false;
  const manager = managerFor('governing_principle', {
    planProbes: async ({ question }) => {
      if (question === 'Job 1') {
        await job1Blocker;
      }
      if (question === 'Job 2') {
        job2Ran = true;
      }
      return [question];
    },
  });

  const job1 = manager.start({
    question: 'Job 1',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    matches: [match('doc1', teaching)],
    readAnswerUnits: async () => [unit('doc1', teaching)],
  });

  for (let i = 0; i < 100 && manager.get(job1.id).status !== 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const job2 = manager.start({
    question: 'Job 2',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    matches: [match('doc2', teaching)],
    readAnswerUnits: async () => [unit('doc2', teaching)],
  });

  assert.equal(manager.get(job2.id).status, 'queued');
  assert.equal(manager.getQueueLength(), 1);

  // Cancel Job 2 while still queued
  const cancelled2 = manager.cancel(job2.id);
  assert.equal(cancelled2.status, 'cancelled');
  assert.equal(cancelled2.terminationReason, 'cancelled');
  assert.equal(manager.getQueueLength(), 0);

  // Unblock Job 1
  releaseJob1();
  const completed1 = await waitForTerminal(manager, job1.id);
  assert.equal(completed1.status, 'completed');

  // Verify Job 2 never ran
  assert.equal(job2Ran, false);
  assert.equal(manager.get(job2.id).status, 'cancelled');
});

test('cancellation during adjudication marks active phase cancelled and frees active requests', async () => {
  let adjudicateStarted = false;
  let signalAborted = false;
  const teaching = 'Right action brings peace.';
  const manager = managerFor('governing_principle', {
    adjudicate: ({ signal }) => new Promise((_resolve, reject) => {
      adjudicateStarted = true;
      signal.addEventListener('abort', () => {
        signalAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });

  const job = manager.start({
    question: 'Right action?',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    matches: [match('doc1', teaching)],
    readAnswerUnits: async () => [unit('doc1', teaching)],
  });

  for (let i = 0; i < 200 && !adjudicateStarted; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(adjudicateStarted, true);

  manager.cancel(job.id);
  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'cancelled');
  assert.equal(completed.terminationReason, 'cancelled');
  assert.equal(signalAborted, true);
  assert.equal(completed.activeRequests, 0);
});

test('job timeout marks job failed with timeout termination reason', async () => {
  const teaching = 'Time is irreversible.';
  const manager = managerFor('governing_principle', {
    planProbes: () => new Promise(() => {}), // Never resolves
  });

  const job = manager.start({
    question: 'Time?',
    model: 'qwen3:14b-q8_0',
    baseUrl: 'http://127.0.0.1:11434',
    jobTimeoutMs: 30, // 30ms timeout
    matches: [match('doc1', teaching)],
    readAnswerUnits: async () => [unit('doc1', teaching)],
  });

  const completed = await waitForTerminal(manager, job.id);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.terminationReason, 'timeout');
  assert.match(completed.error, /timed out/iu);
});
