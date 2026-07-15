const test = require('node:test');
const assert = require('node:assert/strict');
const { testPostgresConnection, testIndexConnection } = require('../src/database');
const { testOllama } = require('../src/ollama');

const enabled = Boolean(process.env.SEMANTIC_QA_TEST_SOURCE_URL && process.env.SEMANTIC_QA_TEST_INDEX_URL && process.env.SEMANTIC_QA_TEST_OLLAMA);

test('environment-gated PostgreSQL, pgvector, and Ollama connectivity', { skip: !enabled }, async () => {
  const source = await testPostgresConnection({ connectionString: process.env.SEMANTIC_QA_TEST_SOURCE_URL });
  const index = await testIndexConnection({ connectionString: process.env.SEMANTIC_QA_TEST_INDEX_URL });
  const model = await testOllama({ baseUrl: process.env.SEMANTIC_QA_TEST_OLLAMA, model: process.env.SEMANTIC_QA_TEST_MODEL || 'embeddinggemma' });
  assert.ok(source.database);
  assert.ok(index.database);
  assert.ok(model.dimension > 0);
});
