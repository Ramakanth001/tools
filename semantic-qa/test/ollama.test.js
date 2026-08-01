const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModelReference, testOllama } = require('../src/ollama');

test('normalizes implicit latest model tags', () => {
  assert.equal(normalizeModelReference('embeddinggemma'), 'embeddinggemma:latest');
  assert.equal(normalizeModelReference('EmbeddingGemma:Q8_0'), 'embeddinggemma:q8_0');
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
