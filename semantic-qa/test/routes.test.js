const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { requireToolDep } = require('../requireToolDep');
const { registerSemanticQaRoutes } = require('../src/registerRoutes');
const { EMBEDDINGGEMMA_FORMAT, RETRIEVAL_SCHEMA_VERSION } = require('../src/core');

const express = requireToolDep('express');

function asPassage(row) {
  return {
    passageIndex: 0,
    passageText: row.answer,
    passageStart: 0,
    passageEnd: row.answer.length,
    ...row,
  };
}

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
    testChatModel: async () => ({ ok: true, model: 'gemma3:4b' }),
    requireThinkingModel: async () => ({ ok: true, model: 'qwen3:14b-q8_0', capabilities: ['thinking'] }),
    embedTexts: async () => [[0.1, 0.2, 0.3]],
    generateGroundedAnswer: async ({ evidence }) => ({ answer: evidence[0].text, evidenceNumbers: [1] }),
    ...(overrides.ollama || {}),
  };
  const syncManager = { start: () => ({ id: 'job' }), get: () => null, cancel: () => null, subscribe: () => false, unsubscribe: () => {} };
  registerSemanticQaRoutes(app, { basePath: '/api', deps: {
    database,
    ollama,
    syncManager,
    ...(overrides.deepSummaryManager ? { deepSummaryManager: overrides.deepSummaryManager } : {}),
    ...(overrides.distanceSearch ? { distanceSearch: overrides.distanceSearch } : {}),
  } });
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

test('Ollama hardware endpoint reports detected devices and actual model allocation', async () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/api/ollama/hardware`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'gemma3:4b' }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.hardware.gpuAvailable, true);
  assert.equal(payload.hardware.runtime.processor, '100% GPU');
}, {
  ollama: {
    getOllamaHardware: async () => ({ gpuAvailable: true, runtime: { processor: '100% GPU' }, host: { accelerators: [{ name: 'Test GPU' }] } }),
  },
}));

test('search uses the corpus embedding format and ranks indexed answer passages', async () => {
  let embeddedText;
  let lexicalQuery;
  let candidateLimit;
  let discoveryQuestion;
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
    assert.equal(payload.retrieval, 'passage-hybrid');
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
      searchPassageIndex: async (_connection, _vector, query, limit, originalQuestion) => {
        lexicalQuery = query;
        candidateLimit = limit;
        discoveryQuestion = originalQuestion;
        return {
          hybrid: true,
          rows: [
            { sourceId: 'where', question: 'Where can I meet Datta Swami?', answer: 'Call this phone number.', similarity: 0.71, lexicalScore: 0.2, sourceGroup: 'where', metadata: { chunk_index: 1, chunk_count: 1 } },
            { sourceId: 'who:009', question: 'WHO IS SWAMI?', answer: 'A devotee founded the Mission.', similarity: 0.40, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 9, chunk_count: 9 } },
            { sourceId: 'who:001', question: 'WHO IS SWAMI?', answer: 'Datta Swami is a spiritual teacher.', similarity: 0.82, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 1, chunk_count: 9 } },
          ].map(asPassage),
        };
      },
    },
    ollama: {
      embedTexts: async ({ texts }) => { [embeddedText] = texts; return [[0.1, 0.2, 0.3]]; },
    },
  });
  assert.equal(embeddedText, 'task: question answering | query: Who is Datta Swami?');
  assert.equal(lexicalQuery, 'datta OR swami');
  assert.equal(candidateLimit, 200);
  assert.equal(discoveryQuestion, 'Who is Datta Swami?');
});

test('search preserves exact structured Q&A precedence while hiding internal ranking signals', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'Why is "karma fruit" emphasized?', topK: 2, threshold: 0.5,
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.matches[0].sourceId, 'paired-qa');
    assert.equal(payload.acceptedMatch.sourceId, 'paired-qa');
    assert.equal('rankingSignals' in payload.matches[0], false);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true, recordCount: 2,
        corpus: {
          embeddingModel: 'embeddinggemma', embeddingModelDigest: 'model-digest',
          embeddingDimension: 3, embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT,
          retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
      searchPassageIndex: async () => ({
        hybrid: true,
        rows: [
          asPassage({
            sourceId: 'neighbor', question: 'Nearby discourse',
            answer: 'This passage repeats the exact karma fruit phrase.', similarity: 0.91,
            sourceGroup: 'neighbor', metadata: { source_type: 'discourse' },
          }),
          asPassage({
            sourceId: 'paired-qa', question: 'Why is "karma fruit" emphasized?',
            answer: 'Swami gives the complete explanation without repeating that wording.', similarity: 0.73,
            discoverySimilarity: 0.95, discoveryExact: true,
            sourceGroup: 'paired-qa', metadata: { source_type: 'qa' },
          }),
        ],
      }),
    },
  });
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
  assert.equal(payload.checks.summaryModel.status, 'ready');
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

test('grounded summary synthesizes only from independently relevant answer passages', async () => {
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
      searchPassageIndex: async (_connection, _vector, _query, limit) => {
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
          ].map(asPassage),
        };
      },
    },
    ollama: {
      embedTexts: async ({ texts }) => { embeddedInputs.push(...texts); return [[1, 0, 0]]; },
      generateGroundedAnswer: async ({ evidence }) => ({
        answer: 'Serve usefully without seeking reward or recognition.',
        evidenceNumbers: evidence.map((_, index) => index + 1),
      }),
    },
  });
  assert.equal(searchLimit, 720);
  assert.equal(embeddedInputs.length, 1);
});

test('verbatim selection does not depend on a summary generation model', async () => {
  let embeddingCalls = 0;
  let generationCalls = 0;
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
    assert.equal(payload.summary.status, 'ready');
    assert.equal(payload.summary.mode, 'verbatim-selection');
    assert.equal(payload.summary.text, 'This stored answer remains visible if summary embedding fails.');
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
      searchPassageIndex: async () => ({
        hybrid: true,
        rows: [{
          sourceId: 'accepted',
          question: 'What is the supported answer?',
          answer: 'This stored answer remains visible if summary embedding fails.',
          similarity: 0.82,
          lexicalScore: 0.2,
          metadata: { source_type: 'qa' },
        }].map(asPassage),
      }),
    },
    ollama: {
      embedTexts: async () => {
        embeddingCalls += 1;
        return [[1, 0, 0]];
      },
      generateGroundedAnswer: async () => { generationCalls += 1; throw new Error('summary model unavailable'); },
    },
  });
  assert.equal(embeddingCalls, 1);
  assert.equal(generationCalls, 0);
});

test('fast verbatim mode labels a semantic neighbor as related without composing an answer', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'Can an oil lamp heat my house?', threshold: 0.49,
        summary: { enabled: true },
      }),
    });
    const payload = await response.json();
    assert.equal(payload.strongMatch, true);
    assert.equal(payload.acceptedMatch.sourceId, 'lamp');
    assert.equal(payload.matches.length, 1);
    assert.deepEqual(payload.relevantMatches.map((item) => item.sourceId), ['lamp']);
    assert.equal(payload.summary.answerStatus, 'related_teachings');
    assert.equal(payload.summary.text, 'Oil lamps provide light.');
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
      searchPassageIndex: async () => ({
        hybrid: true,
        rows: [asPassage({
          sourceId: 'lamp', question: 'Oil lamps',
          answer: 'Oil lamps provide light.', similarity: 0.70,
        })],
      }),
    },
    ollama: {
      embedTexts: async () => [[1, 0, 0]],
      generateGroundedAnswer: async () => ({ answerable: false, answer: '', evidenceNumbers: [] }),
    },
  });
});

test('weak searches never perform summary generation', async () => {
  let embeddingCalls = 0;
  let generationCalls = 0;
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
      searchPassageIndex: async () => ({
        hybrid: true,
        rows: [{
          sourceId: 'weak',
          question: 'Different topic',
          answer: 'A completely different answer.',
          similarity: 0.10,
          lexicalScore: 0,
          metadata: {},
        }].map(asPassage),
      }),
    },
    ollama: {
      embedTexts: async () => {
        embeddingCalls += 1;
        return [[1, 0, 0]];
      },
      generateGroundedAnswer: async () => { generationCalls += 1; return { answer: 'wrong', evidenceNumbers: [1] }; },
    },
  });
  assert.equal(embeddingCalls, 1);
  assert.equal(generationCalls, 0);
});

test('conventional Search uses text RRF without calling the embedding model', async () => {
  let embeddingCalls = 0;
  let textQuery;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'light is in me', searchMode: 'search', topK: 5,
        summary: { enabled: false, mode: 'off' },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.searchMode, 'search');
    assert.equal(payload.retrieval, 'text-rrf');
    assert.equal(payload.matches[0].sourceId, 'discourse:810:005');
    assert.equal(payload.matches[0].matchedPassages[0].matchChannels.includes('exact passage'), true);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true, recordCount: 1,
        corpus: {
          embeddingModel: 'embeddinggemma', embeddingModelDigest: 'model-digest', embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT, retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
      searchTextIndex: async (_connection, query) => {
        textQuery = query;
        return { hybrid: true, rows: [{
          sourceId: 'discourse:810:005', sourceGroup: 'discourse:810', sourceOrder: 5,
          question: 'The three statements of Jesus', answer: 'The Light is in Me means qualified monism.',
          metadata: { source_type: 'discourse', chunk_count: 5 }, passageIndex: 0,
          passageText: 'The Light is in Me means qualified monism.', passageStart: 0, passageEnd: 43,
          searchScore: 0.72, lexicalScore: 0.4, trigramSimilarity: 0.8, matchChannels: ['exact passage', 'full text'],
        }] };
      },
    },
    ollama: { embedTexts: async () => { embeddingCalls += 1; return [[1, 0, 0]]; } },
  });
  assert.equal(textQuery, 'light is in me');
  assert.equal(embeddingCalls, 0);
});

test('document catalog and viewer return a reconstructed highlighted discourse', async () => {
  let listQuery;
  await withServer(async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/documents/list`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ indexConnection: { host: 'db', user: 'writer', database: 'index' }, query: 'what is mula maya?', page: 1, pageSize: 50 }),
    });
    const list = await listResponse.json();
    assert.equal(list.documents[0].sourceGroup, 'discourse:810');
    assert.equal(list.documents[0].answerPreview, 'The Light is in Me means qualified monism.');
    assert.equal(list.documents[0].matchKind, 'Exact answer match');
    assert.equal(listQuery, 'what is mula maya?');

    const documentResponse = await fetch(`${baseUrl}/api/documents/get`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' }, reference: 'discourse:810:002',
        highlights: [{ sourceId: 'discourse:810:002', start: 0, end: 18, label: 'Evidence' }],
      }),
    });
    const payload = await documentResponse.json();
    assert.equal(documentResponse.status, 200);
    assert.equal(payload.document.sourceGroup, 'discourse:810');
    assert.equal(payload.document.text, 'First chunk.\n\nThe Light is in Me means qualified monism.');
    assert.equal(payload.document.text.slice(payload.document.highlights[0].start, payload.document.highlights[0].end), 'The Light is in Me');
  }, {
    database: {
      listDocuments: async (_connection, data) => {
        listQuery = data.query;
        return {
          page: 1, pageSize: 50, total: 1,
          documents: [{
            sourceGroup: 'discourse:810', title: 'Jesus', chunkCount: 2,
            answerPreview: 'The Light is in Me means qualified monism.', matchKind: 'Exact answer match',
          }],
        };
      },
      getDocumentRecords: async () => [
        { sourceId: 'discourse:810:001', sourceGroup: 'discourse:810', sourceOrder: 1, question: 'Jesus', answer: 'First chunk.', metadata: { source_type: 'discourse' } },
        { sourceId: 'discourse:810:002', sourceGroup: 'discourse:810', sourceOrder: 2, question: 'Jesus', answer: 'The Light is in Me means qualified monism.', metadata: { source_type: 'discourse' } },
      ],
    },
  });
});

test('Deep Search starts an asynchronous role-aware job with the dedicated Qwen model', async () => {
  const started = [];
  let exhaustiveCalls = 0;
  let exhaustiveArguments = [];
  const deepSummaryManager = {
    start: (config) => { started.push(config); return { id: 'deep-1', status: 'queued', phase: 'queued', processed: 0, total: 0, percent: 0 }; },
    get: () => ({ id: 'deep-1', status: 'running' }), cancel: () => ({ id: 'deep-1', status: 'running' }),
    subscribe: () => true, unsubscribe: () => {},
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' }, question: 'What does the phrase mean?',
        searchMode: 'semantic', threshold: 0.49,
        summary: { enabled: false, mode: 'deep', deepModel: 'qwen3:14b-q8_0', deepMaxRecords: 37, hardwarePreference: 'gpu' },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.deepSummaryJob.id, 'deep-1');
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true, recordCount: 1,
        corpus: {
          embeddingModel: 'embeddinggemma', embeddingModelDigest: 'model-digest', embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT, retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
        },
      }),
      searchAllPassageIndex: async (...args) => {
        exhaustiveCalls += 1;
        exhaustiveArguments = args;
        return { hybrid: true, exhaustive: true, scannedPassages: 19777, rows: [asPassage({
          sourceId: 'meaning', question: 'Meaning', answer: 'The passage explains the phrase.', similarity: 0.8, metadata: {},
        })] };
      },
    },
    deepSummaryManager,
  });
  assert.equal(started.length, 1);
  assert.equal(exhaustiveCalls, 1);
  assert.equal(started[0].matches[0].sourceId, 'meaning');
  assert.deepEqual(started[0].retrievalCoverage, { exhaustive: true, scannedPassages: 19777 });
  assert.equal(started[0].model, 'qwen3:14b-q8_0');
  assert.equal(started[0].parallelRequests, 1);
  assert.equal(started[0].requestTimeoutMs, 600000);
  assert.equal(started[0].maxRecords, 37);
  assert.equal(exhaustiveArguments[4], 111);
  assert.equal(started[0].hardwarePreference, 'gpu');
});

test('v4 remains available only for ordinary search during the role-aware rebuild', async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' }, question: 'Question',
        searchMode: 'search', summary: { enabled: false, mode: 'off' },
      }),
    });
    assert.equal(ordinary.status, 200);
    const roleAware = await fetch(`${baseUrl}/api/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' }, question: 'Question',
        searchMode: 'search', summary: { enabled: true, mode: 'standard' },
      }),
    });
    assert.equal(roleAware.status, 409);
    assert.match((await roleAware.json()).error, /Ordinary v4 search remains available/iu);
  }, {
    database: {
      getIndexStatus: async () => ({
        initialized: true, recordCount: 1,
        corpus: {
          embeddingModel: 'embeddinggemma', embeddingModelDigest: 'model-digest', embeddingDimension: 3,
          embeddingFormatVersion: EMBEDDINGGEMMA_FORMAT, retrievalSchemaVersion: 'passage-v4',
        },
      }),
      searchTextIndex: async () => ({ rows: [asPassage({ sourceId: 'v4:1', question: 'Question', answer: 'Legacy exact text.' })] }),
    },
  });
});


test('distance search route delegates cleanly to distance engine and honors topK', async () => {
  let calledQuery;
  let calledLimit;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'meaning of gayatri mantra',
        searchMode: 'distance',
        topK: 15,
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.searchMode, 'distance');
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].title, 'Meaning of the Gayatri Mantra');
  }, {
    distanceSearch: {
      searchDistanceCorpus: async (_pool, { query, limit }) => {
        calledQuery = query;
        calledLimit = limit;
        return {
          query,
          totalFound: 1,
          executionTimeMs: 42,
          matches: [{
            sourceId: 'discourse:388',
            title: 'Meaning of the Gayatri Mantra',
            score: 95.5,
          }],
        };
      },
    },
  });
  assert.equal(calledQuery, 'meaning of gayatri mantra');
  assert.equal(calledLimit, 15);
});

test('distance search route defaults topK to 35 when omitted by direct API callers', async () => {
  let calledLimit;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexConnection: { host: 'db', user: 'writer', database: 'index' },
        question: 'meaning of gayatri mantra',
        searchMode: 'distance',
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.searchMode, 'distance');
  }, {
    distanceSearch: {
      searchDistanceCorpus: async (_pool, { limit }) => {
        calledLimit = limit;
        return {
          query: 'meaning of gayatri mantra',
          totalFound: 0,
          executionTimeMs: 10,
          matches: [],
        };
      },
    },
  });
  assert.equal(calledLimit, 35, 'Omitted topK must default to 35 for distance search');
});
