const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyHardwarePreference,
  cleanGeneratedAnswer,
  consolidateGroundedClaims,
  extractGroundedClaims,
  generateGroundedAnswer,
  normalizeModelReference,
  parseStructuredJson,
  summarizeOllamaProcessor,
  synthesizeDeepAnswer,
  testOllama,
  validateEvidenceBatch,
  verifyGroundedAnswer,
} = require('../src/ollama');

test('normalizes implicit latest model tags', () => {
  assert.equal(normalizeModelReference('embeddinggemma'), 'embeddinggemma:latest');
  assert.equal(normalizeModelReference('EmbeddingGemma:Q8_0'), 'embeddinggemma:q8_0');
});

test('hardware preference maps to Ollama layer offload and runtime allocation is reported honestly', () => {
  assert.deepEqual(applyHardwarePreference({ num_ctx: 8192 }, 'auto'), { num_ctx: 8192 });
  assert.deepEqual(applyHardwarePreference({ num_ctx: 8192 }, 'cpu'), { num_ctx: 8192, num_gpu: 0 });
  assert.deepEqual(applyHardwarePreference({ num_ctx: 8192 }, 'gpu'), { num_ctx: 8192, num_gpu: 999 });
  assert.equal(summarizeOllamaProcessor({ name: 'gemma3:4b', size: 4000, size_vram: 4000 }).processor, '100% GPU');
  assert.equal(summarizeOllamaProcessor({ name: 'gemma3:4b', size: 4000, size_vram: 1000 }).processor, '75% CPU / 25% GPU');
  assert.equal(summarizeOllamaProcessor({ name: 'gemma3:4b', size: 4000, size_vram: 0 }).processor, '100% CPU');
});

test('removes model-written citation boilerplate while preserving the answer', () => {
  assert.equal(
    cleanGeneratedAnswer('It means qualified monism, as described in the evidence_numbers [1], [2] and [3].'),
    'It means qualified monism.',
  );
  assert.equal(
    cleanGeneratedAnswer('It is intermediate within the religion_numbers,,. It is not complete monism_numbers.'),
    'It is intermediate within the religion. It is not complete monism.',
  );
});

test('structured JSON parsing tolerates fenced local-model output', () => {
  assert.deepEqual(parseStructuredJson('```json\n{"accepted_numbers":[1]}\n```', 'test'), { accepted_numbers: [1] });
  assert.deepEqual(parseStructuredJson('Result: {"title":"Answer"}', 'test'), { title: 'Answer' });
});

test('grounded generation sends only supplied evidence and validates citations', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          requested_relation: 'meaning of the quoted phrase',
          evidence_relation: 'meaning of the quoted phrase',
          relation_matches: true,
          answerable: true,
          answer: 'The phrase signifies qualified monism.',
          evidence_numbers: [1],
        }),
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await generateGroundedAnswer({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'gemma3:4b',
      question: 'What does The Light is in Me mean?',
      evidence: [{ text: 'The Light is in Me means qualified monism.' }],
      hardwarePreference: 'gpu',
    });
    assert.equal(result.answer, 'The phrase signifies qualified monism.');
    assert.deepEqual(result.evidenceNumbers, [1]);
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[1].content, /qualified monism/);
    assert.equal(requests[0].stream, false);
    assert.equal(requests[0].format.type, 'object');
    assert.equal(requests[0].options.num_gpu, 999);
  } finally {
    global.fetch = originalFetch;
  }
});

test('answer adequacy verification rejects a topical description that does not fulfill a how-to request', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({
      requested_deliverable: 'a method for stopping the behavior',
      answer_deliverable: 'a description of why avoiding the behavior is difficult',
      directly_answers: false,
      fully_supported: true,
      reason: 'No method or actionable guidance is supplied.',
    }) },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const result = await verifyGroundedAnswer({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'gemma3:4b',
      question: 'How can I stop watching pornography?',
      answer: 'Such material is widespread and difficult to avoid.',
      evidence: [{ text: 'Modern media makes such material difficult to avoid.' }],
    });
    assert.deepEqual(result, { directlyAnswers: false, fullySupported: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('grounded generation can reject evidence that is only topically related', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({
      requested_relation: 'use a lamp for heat',
      evidence_relation: 'use a lamp for light',
      relation_matches: false,
      answerable: false,
      answer: '',
      evidence_numbers: [],
    }) },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const result = await generateGroundedAnswer({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'gemma3:4b',
      question: 'Can this lamp heat a house?',
      evidence: [{ text: 'The lamp provides light.' }],
    });
    assert.deepEqual(result, { answerable: false, answer: '', evidenceNumbers: [] });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Ollama diagnostics return the immutable model digest with the embedding dimension', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({
        models: [{
          name: 'embeddinggemma:latest',
          model: 'embeddinggemma:latest',
          digest: 'sha256-model-digest',
          modified_at: '2026-07-17T00:00:00Z',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await testOllama({ baseUrl: 'http://127.0.0.1:11434', model: 'embeddinggemma' });
    assert.equal(result.digest, 'sha256-model-digest');
    assert.equal(result.resolvedModel, 'embeddinggemma:latest');
    assert.equal(result.dimension, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('deep summary helpers validate neighbors and keep structured claim citations', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  const responses = [
    { accepted_numbers: [1], rejected_numbers: [2] },
    { claims: [{ text: 'The phrase denotes qualified monism. (Evidence 1)', evidence_numbers: [1] }] },
    { claims: [{ text: 'The phrase denotes qualified monism.', claim_numbers: [1] }] },
    { title: 'Meaning of the phrase', paragraphs: [{ text: 'It denotes qualified monism in one connected explanation.', claim_numbers: [1] }] },
  ];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ message: { content: JSON.stringify(responses.shift()) } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const accepted = await validateEvidenceBatch({
      baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', question: 'What does it mean?',
      evidence: [{ text: 'Direct meaning.' }, { text: 'Different topic.' }],
    });
    assert.deepEqual(accepted, [1]);
    const claims = await extractGroundedClaims({
      baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', question: 'What does it mean?',
      evidence: [{ text: 'The phrase denotes qualified monism.' }],
    });
    assert.deepEqual(claims, [{ text: 'The phrase denotes qualified monism.', evidenceNumbers: [1] }]);
    const consolidated = await consolidateGroundedClaims({
      baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', question: 'What does it mean?', claims,
    });
    assert.deepEqual(consolidated, [{ text: 'The phrase denotes qualified monism.', claimNumbers: [1] }]);
    const answer = await synthesizeDeepAnswer({
      baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', question: 'What does it mean?', claims,
    });
    assert.deepEqual(answer.paragraphs[0].claimNumbers, [1]);
    assert.match(answer.paragraphs[0].text, /connected explanation/);
    assert.match(requests[1].messages[0].content, /Preserve the evidence wording/);
    assert.match(requests[2].messages[0].content, /Preserve the clearest source wording/);
    assert.match(requests[3].messages[0].content, /paraphrase only as much as needed/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('deep claim extraction retries malformed structured output', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const content = calls === 1
      ? '{"claims":[{"text":"truncated"'
      : JSON.stringify({ claims: [{ text: 'Recovered grounded claim.', evidence_numbers: [1] }] });
    return new Response(JSON.stringify({ message: { content } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const claims = await extractGroundedClaims({
      baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', question: 'What is the meaning?',
      evidence: [{ text: 'The verified evidence explains the meaning.' }],
    });
    assert.equal(calls, 2);
    assert.deepEqual(claims, [{ text: 'Recovered grounded claim.', evidenceNumbers: [1] }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('deep synthesis removes model citation markers and joins adjacent fragments from the same grounded point', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ message: { content: JSON.stringify({
    title: 'Direct answer',
    paragraphs: [
      { text: 'Realisation means recognising the sin. [1]', claim_numbers: [1] },
      { text: 'Repentance means feeling sorry for it. [1]', claim_numbers: [1] },
      { text: 'Non-repetition is the practical proof. [2]', claim_numbers: [2] },
    ],
  }) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const result = await synthesizeDeepAnswer({
      baseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b', question: 'What is reformation?',
      claims: [{ text: 'Realisation and repentance.' }, { text: 'Non-repetition is proof.' }],
    });
    assert.equal(result.paragraphs.length, 2);
    assert.equal(result.paragraphs[0].text, 'Realisation means recognising the sin. Repentance means feeling sorry for it.');
    assert.deepEqual(result.paragraphs[0].claimNumbers, [1]);
    assert.equal(result.paragraphs[1].text, 'Non-repetition is the practical proof.');
  } finally {
    global.fetch = originalFetch;
  }
});
