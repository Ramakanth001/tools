const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanGeneratedAnswer,
  generateGroundedAnswer,
  normalizeModelReference,
  testOllama,
  verifyGroundedAnswer,
} = require('../src/ollama');

test('normalizes implicit latest model tags', () => {
  assert.equal(normalizeModelReference('embeddinggemma'), 'embeddinggemma:latest');
  assert.equal(normalizeModelReference('EmbeddingGemma:Q8_0'), 'embeddinggemma:q8_0');
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
    });
    assert.equal(result.answer, 'The phrase signifies qualified monism.');
    assert.deepEqual(result.evidenceNumbers, [1]);
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[1].content, /qualified monism/);
    assert.equal(requests[0].stream, false);
    assert.equal(requests[0].format.type, 'object');
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
