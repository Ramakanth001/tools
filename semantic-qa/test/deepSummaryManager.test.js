const test = require('node:test');
const assert = require('node:assert/strict');
const { collectCandidateEvidence, createDeepSummaryManager } = require('../src/deepSummaryManager');

function match(sourceId, score, similarity, text, question = 'Q') {
  return { sourceId, sourceGroup: sourceId, question, relevanceScore: score, similarity, matchedPassages: [{ text, start: 0, end: text.length }] };
}

test('deep evidence collection includes eligible inspection neighbors without automatically accepting them', () => {
  const result = collectCandidateEvidence([
    match('accepted', 0.60, 0.60, 'Accepted evidence.'),
    match('neighbor', 0.42, 0.40, 'Inspection neighbor.'),
    match('weak', 0.10, 0.10, 'Unrelated.'),
  ], { searchMode: 'semantic', threshold: 0.49, maxRecords: 60 });
  assert.deepEqual(result.evidence.map((item) => item.sourceId), ['accepted', 'neighbor']);
  assert.equal(result.evidence[0].automaticallyAccepted, true);
  assert.equal(result.evidence[1].automaticallyAccepted, false);
});

test('deep evidence preserves the indexed discourse title with the relevant passage', () => {
  const result = collectCandidateEvidence([
    match('discourse:810:005', 0.70, 0.70, 'The Light is in Me means qualified monism.', 'The Three Statements of Jesus'),
  ], { searchMode: 'semantic', threshold: 0.49 });
  assert.equal(result.evidence[0].sourceTitle, 'The Three Statements of Jesus');
  assert.equal(result.evidence[0].text, 'The Light is in Me means qualified monism.');
});

test('deep evidence collection does not truncate corpus-wide candidates at the former configured limit', () => {
  const matches = Array.from({ length: 140 }, (_value, index) => match(`source-${index}`, 0.60, 0.60, `Distinct evidence ${index}.`));
  const result = collectCandidateEvidence(matches, {
    searchMode: 'semantic', threshold: 0.49, maxRecords: 60,
    retrievalCoverage: { exhaustive: true, scannedPassages: 19777 },
  });
  assert.equal(result.evidence.length, 140);
  assert.equal(result.exhaustive, true);
  assert.equal(result.scannedPassages, 19777);
});

test('conventional text candidates always require independent deep-summary validation', () => {
  const result = collectCandidateEvidence([
    match('exact', 0.90, 0.90, 'Exact phrase evidence.'),
  ], { searchMode: 'search', threshold: 0.08, maxRecords: 60 });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].automaticallyAccepted, false);
});

test('semantic neighbors that change an implicit saying phrase require verification', () => {
  const result = collectCandidateEvidence([
    match('exact', 0.60, 0.60, 'The Light is in Me means qualified monism.'),
    match('nearby', 0.70, 0.70, 'I am the Light means monism.'),
  ], {
    question: 'What is the meaning of Jesus saying The light is in me?',
    searchMode: 'semantic', threshold: 0.49, maxRecords: 60,
  });
  assert.equal(result.evidence.find((item) => item.sourceId === 'exact').automaticallyAccepted, true);
  assert.equal(result.evidence.find((item) => item.sourceId === 'nearby').automaticallyAccepted, false);
});

test('deep summary validates exploratory evidence and preserves original citations', async () => {
  const manager = createDeepSummaryManager({
    validateEvidence: async () => [1],
    extractClaims: async ({ evidence }) => evidence.map((item, index) => ({ text: `Claim from ${item.sourceId}.`, evidenceNumbers: [index + 1] })),
    synthesize: async () => ({ title: 'Deep answer', paragraphs: [{ text: 'Combined answer.', claimNumbers: [1, 2] }] }),
  });
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49, maxRecords: 60,
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b',
    matches: [match('accepted', 0.60, 0.60, 'Accepted evidence.'), match('neighbor', 0.42, 0.40, 'Inspection neighbor.')],
  });
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 50 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.status, 'ready');
  assert.deepEqual(completed.result.paragraphs[0].evidenceNumbers, [1, 2]);
  assert.equal(completed.result.coverage.verifiedExpandedRecords, 1);
});

test('deep summary recovers malformed claim batches by splitting and using verified passages as a final fallback', async () => {
  const extractionSizes = [];
  const manager = createDeepSummaryManager({
    validateEvidence: async () => [],
    extractClaims: async ({ evidence }) => {
      extractionSizes.push(evidence.length);
      if (evidence.length > 1) throw new Error('Ollama returned invalid JSON for deep claim extraction');
      if (evidence[0].sourceId === 'fallback') throw new Error('Ollama returned invalid JSON for deep claim extraction');
      return [{ text: `Claim from ${evidence[0].sourceId}.`, evidenceNumbers: [1] }];
    },
    synthesize: async ({ claims }) => ({
      title: 'Recovered answer',
      paragraphs: [{ text: 'Grounded answer.', claimNumbers: claims.map((_claim, index) => index + 1) }],
    }),
  });
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49, maxRecords: 60,
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b',
    matches: [
      match('first', 0.70, 0.70, 'First verified passage.'),
      match('fallback', 0.70, 0.70, 'Fallback verified passage.'),
      match('third', 0.70, 0.70, 'Third verified passage.'),
    ],
  });
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 50 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.status, 'ready');
  assert.ok(extractionSizes.includes(3));
  assert.ok(extractionSizes.includes(1));
  assert.equal(completed.result.coverage.fallbackClaimCount, 1);
  assert.deepEqual(completed.result.paragraphs[0].evidenceNumbers, [1, 2, 3]);
});

test('deep summary hierarchically pools a large corpus-wide claim set before article synthesis', async () => {
  let synthesisClaimCount = 0;
  const manager = createDeepSummaryManager({
    validateEvidence: async () => [],
    extractClaims: async ({ evidence }) => evidence.map((item, index) => ({ text: `Claim from ${item.sourceId}.`, evidenceNumbers: [index + 1] })),
    consolidateClaims: async ({ claims }) => [{
      text: claims.map((claim) => claim.text).join(' '),
      claimNumbers: claims.map((_claim, index) => index + 1),
    }],
    synthesize: async ({ claims }) => {
      synthesisClaimCount = claims.length;
      return { title: 'Pooled answer', paragraphs: [{ text: 'One connected explanation.', claimNumbers: claims.map((_claim, index) => index + 1) }] };
    },
  });
  const matches = Array.from({ length: 42 }, (_value, index) => match(`source-${index}`, 0.70, 0.70, `Verified passage ${index}.`));
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49,
    retrievalCoverage: { exhaustive: true, scannedPassages: 20000 },
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', matches,
  });
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.ok(synthesisClaimCount <= 36);
  assert.equal(completed.result.coverage.exhaustiveScan, true);
  assert.equal(completed.result.coverage.scannedPassages, 20000);
  assert.equal(completed.result.paragraphs[0].evidenceNumbers.length, 42);
});

test('deep summary validates and extracts batches with bounded parallel Ollama requests while preserving evidence order', async () => {
  let activeValidations = 0;
  let maximumActiveValidations = 0;
  const manager = createDeepSummaryManager({
    validateEvidence: async ({ evidence, timeoutMs }) => {
      assert.equal(timeoutMs, 240000);
      activeValidations += 1;
      maximumActiveValidations = Math.max(maximumActiveValidations, activeValidations);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeValidations -= 1;
      return evidence.map((_item, index) => index + 1);
    },
    extractClaims: async ({ evidence, timeoutMs }) => {
      assert.equal(timeoutMs, 240000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return evidence.map((item, index) => ({ text: `Claim from ${item.sourceId}.`, evidenceNumbers: [index + 1] }));
    },
    synthesize: async ({ claims, timeoutMs }) => {
      assert.equal(timeoutMs, 240000);
      return { title: 'Parallel answer', paragraphs: [{ text: 'Combined answer.', claimNumbers: claims.map((_claim, index) => index + 1) }] };
    },
  });
  const matches = Array.from({ length: 16 }, (_value, index) => match(`source-${index}`, 0.42, 0.40, `Exploratory passage ${index}.`));
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49,
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', parallelRequests: 2, requestTimeoutMs: 240000, matches,
  });
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.equal(maximumActiveValidations, 2);
  assert.equal(completed.parallelism, 2);
  assert.deepEqual(completed.result.evidence.map((item) => item.sourceId), matches.map((item) => item.sourceId));
});

test('deep summary splits timed-out validation batches and continues without failing the job', async () => {
  const validationSizes = [];
  const manager = createDeepSummaryManager({
    validateEvidence: async ({ evidence }) => {
      validationSizes.push(evidence.length);
      if (evidence.length > 1) throw new Error('Ollama request timed out');
      return [1];
    },
    extractClaims: async ({ evidence }) => evidence.map((item, index) => ({ text: `Claim from ${item.sourceId}.`, evidenceNumbers: [index + 1] })),
    synthesize: async ({ claims }) => ({
      title: 'Recovered validation',
      paragraphs: [{ text: 'Grounded answer.', claimNumbers: claims.map((_claim, index) => index + 1) }],
    }),
  });
  const matches = Array.from({ length: 3 }, (_value, index) => match(`source-${index}`, 0.42, 0.40, `Exploratory passage ${index}.`));
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49,
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', parallelRequests: 2, matches,
  });
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.ok(validationSizes.includes(3));
  assert.ok(validationSizes.includes(2));
  assert.ok(validationSizes.filter((size) => size === 1).length >= 3);
  assert.equal(completed.result.coverage.verifiedExpandedRecords, 3);
  assert.deepEqual(completed.result.paragraphs[0].evidenceNumbers, [1, 2, 3]);
});

test('deep summary retries an interrupted final synthesis once with a longer timeout', async () => {
  const synthesisTimeouts = [];
  const manager = createDeepSummaryManager({
    validateEvidence: async () => [],
    extractClaims: async () => [{ text: 'Grounded claim.', evidenceNumbers: [1] }],
    synthesize: async ({ timeoutMs }) => {
      synthesisTimeouts.push(timeoutMs);
      if (synthesisTimeouts.length === 1) throw new Error('Ollama request timed out');
      return { title: 'Recovered synthesis', paragraphs: [{ text: 'Grounded answer.', claimNumbers: [1] }] };
    },
  });
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49,
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', requestTimeoutMs: 120000,
    matches: [match('source', 0.70, 0.70, 'Verified passage.')],
  });
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.deepEqual(synthesisTimeouts, [120000, 180000]);
  assert.ok(completed.logs.some((line) => line.includes('retrying once')));
});

test('deep summary exposes completed, current, and pending phases with a rolling ETA', async () => {
  let validationCalls = 0;
  let releaseSecondValidation;
  const secondValidation = new Promise((resolve) => { releaseSecondValidation = resolve; });
  const manager = createDeepSummaryManager({
    validateEvidence: async ({ evidence }) => {
      validationCalls += 1;
      if (validationCalls === 2) await secondValidation;
      return evidence.map((_item, index) => index + 1);
    },
    extractClaims: async ({ evidence }) => evidence.map((item, index) => ({ text: `Point from ${item.sourceId}.`, evidenceNumbers: [index + 1] })),
    synthesize: async ({ claims }) => ({ title: 'Tracked answer', paragraphs: [{ text: 'Grounded answer.', claimNumbers: claims.map((_claim, index) => index + 1) }] }),
  });
  const matches = Array.from({ length: 13 }, (_value, index) => match(`source-${index}`, 0.42, 0.40, `Exploratory passage ${index}.`));
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49, parallelRequests: 1,
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', matches,
  });
  let running = manager.get(job.id);
  for (let attempt = 0; attempt < 100 && running.phaseProcessed < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    running = manager.get(job.id);
  }
  assert.equal(running.phases[0].status, 'completed');
  assert.equal(running.phases[1].status, 'running');
  assert.equal(running.phases[1].processed, 12);
  assert.equal(running.phases[2].status, 'pending');
  assert.ok(running.overallPercent > 2);
  assert.equal(typeof running.etaSeconds, 'number');
  assert.equal(typeof running.phases[1].etaSeconds, 'number');
  assert.ok(running.etaSeconds >= running.phases[1].etaSeconds);
  assert.ok(running.phases[2].estimatedDurationSeconds >= 1);
  assert.equal(running.estimatedTotalSeconds, running.elapsedSeconds + running.etaSeconds);
  releaseSecondValidation();
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.ok(completed.phases.every((phase) => phase.status === 'completed'));
  assert.equal(completed.overallPercent, 100);
  assert.equal(completed.etaSeconds, 0);
});

test('deep summary appends omitted pooled points without paraphrasing them away', async () => {
  const manager = createDeepSummaryManager({
    validateEvidence: async () => [],
    extractClaims: async ({ evidence }) => evidence.map((item, index) => ({ text: `Exact grounded point ${item.sourceId}.`, evidenceNumbers: [index + 1] })),
    synthesize: async ({ maxParagraphs }) => {
      assert.equal(maxParagraphs, 8);
      return { title: 'Complete answer', paragraphs: [{ text: 'First supported paragraph.', claimNumbers: [1] }] };
    },
  });
  const matches = [
    match('first', 0.70, 0.70, 'First verified passage.'),
    match('second', 0.70, 0.70, 'Second verified passage.'),
  ];
  const job = manager.start({
    question: 'Q', searchMode: 'semantic', threshold: 0.49,
    baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', matches,
  });
  let completed = manager.get(job.id);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = manager.get(job.id);
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.paragraphs.length, 2);
  assert.equal(completed.result.paragraphs[1].text, 'Exact grounded point second.');
  assert.deepEqual(completed.result.paragraphs[1].evidenceNumbers, [2]);
  assert.equal(completed.result.coverage.supplementalClaimParagraphs, 1);
});
