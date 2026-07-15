const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { requireToolDep } = require('../requireToolDep');
const { registerSemanticQaRoutes } = require('../src/registerRoutes');

const express = requireToolDep('express');

async function withServer(callback, overrides = {}) {
  const app = express();
  const database = {
    testPostgresConnection: async () => ({ database: 'qa', user: 'reader' }),
    discoverSourceCatalog: async () => [],
    testIndexConnection: async () => ({ database: 'index', user: 'writer', vectorVersion: null }),
    getIndexStatus: async () => ({ initialized: false, corpus: null, recordCount: 0, recentRuns: [] }),
    validateMapping: () => {},
    ...(overrides.database || {}),
  };
  const ollama = {
    testOllama: async () => ({ ok: true, model: 'embeddinggemma', dimension: 3 }),
    embedTexts: async () => [[0.1, 0.2, 0.3]],
    ...(overrides.ollama || {}),
  };
  const syncManager = { start: () => ({ id: 'job' }), get: () => null, cancel: () => null, subscribe: () => false, unsubscribe: () => {} };
  registerSemanticQaRoutes(app, { basePath: '/api', deps: { database, ollama, syncManager } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health and source connection endpoints expose the expected contract', async () => withServer(async (baseUrl) => {
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, tool: 'semantic-qa' });
  const response = await fetch(`${baseUrl}/api/source/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection: { host: 'db', user: 'reader', database: 'qa' } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connection.database, 'qa');
}));

test('search uses the corpus embedding format and hybrid reranks expanded candidates', async () => {
  let embeddedText;
  let lexicalQuery;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'Who is Datta Swami?', topK: 2, threshold: 0.5,
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.retrieval, 'hybrid');
    assert.equal(payload.matches[0].sourceId, 'who:001');
    assert.equal(payload.matches.length, 2);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true, recordCount: 3,
        corpus: { embeddingModel: 'embeddinggemma', embeddingDimension: 3, embeddingFormatVersion: 'embeddinggemma-asymmetric-v2' },
      }),
      searchIndex: async (_connection, _vector, query) => {
        lexicalQuery = query;
        return {
          hybrid: true,
          rows: [
            { sourceId: 'where', question: 'Where can I meet Datta Swami?', answer: 'Call this phone number.', similarity: 0.71, lexicalScore: 0.2, sourceGroup: 'where', metadata: { chunk_index: 1 } },
            { sourceId: 'who:009', question: 'WHO IS SWAMI?', answer: 'A devotee founded the Mission.', similarity: 0.70, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 9 } },
            { sourceId: 'who:001', question: 'WHO IS SWAMI?', answer: 'My name is Venu Gopala Krishna Murthy.', similarity: 0.62, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 1 } },
          ],
        };
      },
    },
    ollama: {
      embedTexts: async ({ texts }) => { [embeddedText] = texts; return [[0.1, 0.2, 0.3]]; },
    },
  });
  assert.equal(embeddedText, 'task: question answering | query: Who is Datta Swami?');
  assert.equal(lexicalQuery, 'datta swami');
});

test('diagnostics reports each external dependency independently', async () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/api/diagnostics`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'embeddinggemma',
      sourceConnection: { host: 'db', user: 'reader', database: 'qa' },
      indexConnection: { host: 'db', user: 'writer', database: 'index' },
    }),
  });
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.checks.api.status, 'ready');
  assert.equal(payload.checks.ollama.status, 'ready');
  assert.equal(payload.checks.sourceDatabase.details.database, 'qa');
  assert.equal(payload.checks.indexDatabase.details.database, 'index');
}));

test('search validation rejects empty questions and empty indexes use exact no-match wording', async () => withServer(async (baseUrl) => {
  const invalid = await fetch(`${baseUrl}/api/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ indexConnection: { host: 'db', user: 'writer', database: 'index' }, question: '' }),
  });
  assert.equal(invalid.status, 400);

  const empty = await fetch(`${baseUrl}/api/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ indexConnection: { host: 'db', user: 'writer', database: 'index' }, question: 'Anything?' }),
  });
  const payload = await empty.json();
  assert.equal(payload.strongMatch, false);
  assert.equal(payload.message, 'I could not find a clear answer in the existing data.');
  assert.deepEqual(payload.matches, []);
}));
