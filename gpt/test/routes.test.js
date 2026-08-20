const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { requireToolDep } = require('../requireToolDep');
const { registerGptRoutes, safeError } = require('../src/registerRoutes');

const express = requireToolDep('express');

test('safe errors redact signed model download URLs', () => {
  const redacted = safeError(new Error('failed https://example.r2.cloudflarestorage.com/blob?X-Amz-Credential=secret&X-Amz-Signature=secret'));
  assert.equal(redacted.includes('X-Amz-Credential'), false);
  assert.match(redacted, /signed download URL removed/);
});

function fakeDeps() {
  const conversations = new Map();
  let messages = [];
  const store = {
    initialize: async () => ({ database: 'spiritual_gpt', user: 'app', initialized: true }),
    persistSettings: async () => {}, listBenchmarks: async () => [],
    listConversations: async () => [...conversations.values()].map((value) => ({ ...value, messageCount: messages.filter((m) => m.conversationId === value.id).length })),
    createConversation: async (title) => { const value = { id: `c${conversations.size + 1}`, title: title || 'New conversation' }; conversations.set(value.id, value); return value; },
    renameConversation: async (id, title) => { const value = { ...conversations.get(id), title }; conversations.set(id, value); return value; },
    deleteConversation: async (id) => { conversations.delete(id); return { id }; },
    getConversation: async (id) => ({ ...conversations.get(id), memory: {}, messages: messages.filter((m) => m.conversationId === id) }),
    recentContext: async () => ({ memory: {}, messages: [], priorEvidence: [] }),
    beginTurn: async (conversationId, content) => { messages.push({ id: 'u1', conversationId, role: 'user', content }); return { turnId: 't1', userMessageId: 'u1' }; },
    updateTurn: async () => {},
    completeTurn: async ({ conversationId, answer, turnId, evidence }) => { messages.push({ id: 'a1', conversationId, role: 'assistant', content: answer, turnId, sources: evidence }); return { assistantMessageId: 'a1' }; },
    failTurn: async () => {}, latestUserQuestion: async () => 'Question?', turnConversation: async () => 'c1',
    saveBenchmark: async () => ({ id: 'b1' }),
  };
  const corpus = {
    inspect: async () => ({ contract: { retrievalSchemaVersion: 'passage-v4' } }), configure: async () => {},
    getSource: async (sourceId, passageIndex) => ({ sourceId, passageIndex, records: [] }),
  };
  const research = { run: async ({ emit }) => { emit('status', { stage: 'searching', message: 'Searching' }); return {
    answer: 'Grounded answer [1]', memory: {}, objective: { standalone_question: 'Question?' }, probes: [{ text: 'Question?' }], stats: { ok: true },
    sources: [{ key: 's:0', sourceId: 's', sourceGroup: null, passageIndex: 0, start: 0, end: 8, excerpt: 'evidence', title: 'Title', metadata: {}, locator: {}, channels: [], scores: {}, adjudication: {}, citationNumber: 1, cited: true }],
  }; } };
  const setupManager = {
    statusDefaults: () => ({ adminConnection: { host: '127.0.0.1', port: 5433, user: 'local-admin' }, indexRole: 'spiritual_gpt_index_reader', chatRole: 'spiritual_gpt_app' }),
    provisionDatabases: async () => ({ indexRole: 'spiritual_gpt_index_reader', chatRole: 'spiritual_gpt_app', chatDatabase: 'spiritual_gpt' }),
  };
  const ollamaClient = {
    listModels: async () => [{ name: 'embeddinggemma:latest' }],
    pullModel: async ({ model, onProgress }) => { onProgress({ status: 'downloading', completed: 5, total: 10 }); return { status: 'success', model }; },
    unload: async () => {},
  };
  return { store, corpus, research, setupManager, ollamaClient };
}

async function withServer(callback) {
  const app = express();
  registerGptRoutes(app, { basePath: '/api', deps: { ...fakeDeps(), settings: {
    chatModel: 'qwen3:14b-q4_K_M', embeddingModel: 'embeddinggemma', ollamaBaseUrl: 'http://127.0.0.1:11434',
    indexConnection: { host: 'db', user: 'reader', database: 'index' }, chatConnection: { host: 'db', user: 'app', database: 'chat' },
  } } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('conversation routes and verified NDJSON answer contract work end to end', async () => withServer(async (base) => {
  const created = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
  assert.equal(created.conversation.id, 'c1');
  const response = await fetch(`${base}/api/conversations/c1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Question?' }) });
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.type === 'status'));
  assert.equal(events.find((event) => event.type === 'answer').message.content, 'Grounded answer [1]');
  assert.equal(events.at(-1).type, 'done');
}));

test('setup rejects arbitrary model tags', async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatModel: 'cloud-model' }) });
  assert.equal(response.status, 400);
}));

test('chat context and answer temperature preferences are validated and persisted', async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextTokens: 12288, responseTemperature: 0.5 }) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.settings.contextTokens, 12288);
  assert.equal(payload.settings.responseTemperature, 0.5);
}));

test('guided setup reports local readiness and provisions fixed database identities', async () => withServer(async (base) => {
  const status = await fetch(`${base}/api/setup/status`).then((response) => response.json());
  assert.equal(status.database.indexRole, 'spiritual_gpt_index_reader');
  assert.equal(status.ollama.models.find((model) => model.model === 'embeddinggemma').installed, true);
  const provisioned = await fetch(`${base}/api/setup/database`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminConnection: { host: '127.0.0.1', user: 'admin' } }),
  }).then((response) => response.json());
  assert.equal(provisioned.result.chatDatabase, 'spiritual_gpt');
}));

test('guided setup streams allowlisted Ollama model progress', async () => withServer(async (base) => {
  const rejected = await fetch(`${base}/api/setup/models/pull`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'remote-model' }),
  });
  assert.equal(rejected.status, 400);
  const response = await fetch(`${base}/api/setup/models/pull`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'embeddinggemma' }),
  });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.type === 'progress' && event.percent === 50));
  assert.equal(events.at(-1).type, 'done');
}));
