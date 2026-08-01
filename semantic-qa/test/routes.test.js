const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { requireToolDep } = require('../requireToolDep');
const { registerSemanticQaRoutes } = require('../src/registerRoutes');
const { EMBEDDINGGEMMA_FORMAT, RETRIEVAL_SCHEMA_VERSION } = require('../src/core');

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
        corpus: {
          embeddingModel: 'embeddinggemma',
          embeddingModelDigest: 'model-digest',
          embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT,
          retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
      searchIndex: async (_connection, _vector, query) => {
        lexicalQuery = query;
        return {
          hybrid: true,
          rows: [
            { sourceId: 'where', question: 'Where can I meet Datta Swami?', answer: 'Call this phone number.', similarity: 0.71, lexicalScore: 0.2, sourceGroup: 'where', metadata: { chunk_index: 1, chunk_count: 1 } },
            { sourceId: 'who:009', question: 'WHO IS SWAMI?', answer: 'A devotee founded the Mission.', similarity: 0.70, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 9, chunk_count: 9 } },
            { sourceId: 'who:001', question: 'WHO IS SWAMI?', answer: 'Datta Swami is a spiritual teacher.', similarity: 0.62, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 1, chunk_count: 9 } },
          ],
        };
      },
    },
    ollama: {
      embedTexts: async ({ texts }) => { [embeddedText] = texts; return [[0.1, 0.2, 0.3]]; },
    },
  });
  assert.equal(embeddedText, 'task: question answering | query: Who is Datta Swami?');
  assert.equal(lexicalQuery, 'datta OR swami');
});

test('search refuses to mix query embeddings with an outdated index format', async () => {
  let embeddingCalls = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'Who is Datta Swami?',
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.requiresRebuild, true);
    assert.match(payload.error, /full rebuild/i);
    assert.equal(embeddingCalls, 0);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true,
        recordCount: 3,
        corpus: {
          embeddingModel: 'embeddinggemma',
          embeddingDimension: 3,
          embeddingFormatVersion: 'embeddinggemma-asymmetric-v2',
          retrievalSchemaVersion: 'hybrid-v2',
        },
      }),
    },
    ollama: {
      embedTexts: async () => { embeddingCalls += 1; return [[0.1, 0.2, 0.3]]; },
    },
  });
});

test('search refuses an Ollama model digest that differs from the indexed model', async () => {
  let embeddingCalls = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'Who is Datta Swami?',
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.requiresRebuild, true);
    assert.match(payload.error, /model.*full rebuild/i);
    assert.equal(embeddingCalls, 0);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true,
        recordCount: 3,
        corpus: {
          embeddingModel: 'embeddinggemma',
          embeddingModelDigest: 'indexed-digest',
          embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT,
          retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
    },
    ollama: {
      getModelIdentity: async () => ({ digest: 'different-digest' }),
      embedTexts: async () => { embeddingCalls += 1; return [[0.1, 0.2, 0.3]]; },
    },
  });
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

test('grounded summary pools only independently relevant records and returns verbatim evidence', async () => {
  let searchLimit;
  const embeddedInputs = [];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'How can I serve without seeking recognition?',
        topK: 1,
        threshold: 0.49,
        summary: { enabled: true, maxRecords: 15, maxLines: 3 },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.strongMatch, true);
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.summary.status, 'ready');
    assert.deepEqual(payload.relevantMatches.map((match) => match.sourceId), ['relevant-a', 'relevant-b']);
    assert.deepEqual(new Set(payload.summary.evidence.map((item) => item.sourceId)), new Set(['relevant-a', 'relevant-b']));
    assert.ok(payload.summary.evidence.every((item) => (
      ['Useful service is done without expecting a personal reward.', 'Sincere service focuses on helping rather than receiving recognition.'].includes(item.text)
    )));
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true,
        recordCount: 3,
        corpus: {
          embeddingModel: 'embeddinggemma',
          embeddingModelDigest: 'model-digest',
          embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT,
          retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
      searchIndex: async (_connection, _vector, _query, limit) => {
        searchLimit = limit;
        return {
          hybrid: true,
          rows: [
            {
              sourceId: 'relevant-a',
              question: 'How can I serve without seeking recognition?',
              answer: 'Useful service is done without expecting a personal reward.',
              similarity: 0.82,
              lexicalScore: 0.2,
              metadata: { source_type: 'qa' },
            },
            {
              sourceId: 'relevant-b',
              question: 'How should sincere service be performed?',
              answer: 'Sincere service focuses on helping rather than receiving recognition.',
              similarity: 0.76,
              lexicalScore: 0.2,
              metadata: { source_type: 'qa' },
            },
            {
              sourceId: 'weak',
              question: 'An unrelated record',
              answer: 'This below-threshold answer must never be summary evidence.',
              similarity: 0.10,
              lexicalScore: 0,
              metadata: {},
            },
          ],
        };
      },
    },
    ollama: {
      embedTexts: async ({ texts }) => {
        embeddedInputs.push(...texts);
        if (texts[0].startsWith('task:')) return [[1, 0, 0]];
        return texts.map((text) => text.includes('Sincere service') ? [0.95, 0.05, 0] : [1, 0, 0]);
      },
    },
  });
  assert.equal(searchLimit, 180);
  assert.ok(embeddedInputs.every((text) => !text.includes('below-threshold')));
});

test('summary embedding failure preserves the accepted stored answer', async () => {
  let embeddingCalls = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'What is the supported answer?',
        threshold: 0.49,
        summary: { enabled: true },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.strongMatch, true);
    assert.equal(payload.acceptedMatch.sourceId, 'accepted');
    assert.equal(payload.summary.status, 'unavailable');
    assert.equal(payload.summary.reason, 'summary_embedding_failed');
    assert.deepEqual(payload.summary.evidence, []);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true,
        recordCount: 1,
        corpus: {
          embeddingModel: 'embeddinggemma',
          embeddingModelDigest: 'model-digest',
          embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT,
          retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
      searchIndex: async () => ({
        hybrid: true,
        rows: [{
          sourceId: 'accepted',
          question: 'What is the supported answer?',
          answer: 'This stored answer remains visible if summary embedding fails.',
          similarity: 0.82,
          lexicalScore: 0.2,
          metadata: { source_type: 'qa' },
        }],
      }),
    },
    ollama: {
      embedTexts: async () => {
        embeddingCalls += 1;
        if (embeddingCalls === 1) return [[1, 0, 0]];
        throw new Error('summary embedding unavailable');
      },
    },
  });
  assert.equal(embeddingCalls, 2);
});

test('weak searches never perform summary embedding', async () => {
  let embeddingCalls = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'Unanswerable question',
        threshold: 0.49,
        summary: { enabled: true },
      }),
    });
    const payload = await response.json();
    assert.equal(payload.strongMatch, false);
    assert.equal(payload.summary.status, 'not_available');
    assert.equal(payload.summary.reason, 'no_relevant_records');
    assert.deepEqual(payload.relevantMatches, []);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true,
        recordCount: 1,
        corpus: {
          embeddingModel: 'embeddinggemma',
          embeddingModelDigest: 'model-digest',
          embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT,
          retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
      searchIndex: async () => ({
        hybrid: true,
        rows: [{
          sourceId: 'weak',
          question: 'Different topic',
          answer: 'A completely different answer.',
          similarity: 0.10,
          lexicalScore: 0,
          metadata: {},
        }],
      }),
    },
    ollama: {
      embedTexts: async () => {
        embeddingCalls += 1;
        return [[1, 0, 0]];
      },
    },
  });
  assert.equal(embeddingCalls, 1);
});
