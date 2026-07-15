const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncManager } = require('../src/syncManager');
const { contentHash } = require('../src/core');

async function waitForTerminal(manager, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = manager.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Job did not finish');
}

function makeDb({ existingHashes = new Map() } = {}) {
  const state = { staged: [], committed: null, dropped: false, runUpdates: [] };
  const client = { release() {} };
  const pool = { async connect() { return client; }, async end() {} };
  const records = [
    { sourceId: '1', question: 'Question one', answer: 'Answer one', metadata: {}, sourceGroup: null, sourceOrder: null },
    { sourceId: '2', question: 'Question two', answer: 'Answer two', metadata: { chapter: 2 }, sourceGroup: 'g', sourceOrder: 2 },
  ];
  return {
    state,
    records,
    db: {
      createPool: () => pool,
      ensureCoreSchema: async () => {},
      getCorpus: async () => ({
        embeddingModel: 'embeddinggemma',
        embeddingDimension: 3,
        embeddingFormatVersion: 'embeddinggemma-asymmetric-v2',
        retrievalSchemaVersion: 'hybrid-v2',
      }),
      createSyncRun: async () => {},
      createSyncStage: async () => ({ stage: 'stage', seen: 'seen' }),
      openSourceSnapshot: async () => ({
        total: records.length,
        mapping: { schema: 'public', table: 'qa' },
        readBatch: async (offset, limit) => records.slice(offset, offset + limit),
        close: async () => {},
      }),
      updateSyncRun: async (_client, job) => state.runUpdates.push(job.status),
      insertSeen: async () => {},
      getExistingHashes: async () => existingHashes,
      insertStageRecords: async (_client, _table, rows) => state.staged.push(...rows),
      commitIncremental: async () => { state.committed = 'incremental'; },
      commitRebuild: async () => { state.committed = 'rebuild'; },
      dropSyncStage: async () => { state.dropped = true; },
    },
  };
}

const config = () => ({
  sourceConnection: { host: 'source' }, indexConnection: { host: 'index' },
  mapping: { schema: 'public', table: 'qa', idColumn: 'id', questionColumn: 'question', answerColumn: 'answer', metadataColumns: [] },
  mode: 'incremental', ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'embeddinggemma',
  fetchSize: 25, embeddingBatchSize: 2,
});

test('incremental sync stages changed records and commits only after a complete scan', async () => {
  const { db, state } = makeDb();
  const manager = createSyncManager({
    db,
    probe: async () => ({ dimension: 3 }),
    embed: async ({ texts }) => texts.map((_, index) => [index + 0.1, 0.2, 0.3]),
  });
  const started = manager.start(config());
  const finished = await waitForTerminal(manager, started.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.processed, 2);
  assert.equal(finished.changed, 2);
  assert.equal(state.staged.length, 2);
  assert.equal(state.committed, 'incremental');
  assert.equal(state.dropped, false);
});

test('embedding failure drops staging and never commits', async () => {
  const { db, state } = makeDb();
  const manager = createSyncManager({
    db,
    probe: async () => ({ dimension: 3 }),
    embed: async () => { throw new Error('input exceeds context window'); },
  });
  const started = manager.start(config());
  const finished = await waitForTerminal(manager, started.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /source records/);
  assert.equal(state.committed, null);
  assert.equal(state.dropped, true);
});

test('full rebuild embeds every record and uses the atomic rebuild commit', async () => {
  const { db, state } = makeDb();
  const manager = createSyncManager({
    db,
    probe: async () => ({ dimension: 3 }),
    embed: async ({ texts }) => texts.map(() => [0.1, 0.2, 0.3]),
  });
  const started = manager.start({ ...config(), mode: 'rebuild' });
  const finished = await waitForTerminal(manager, started.id);
  assert.equal(finished.status, 'completed');
  assert.equal(state.committed, 'rebuild');
  assert.equal(state.staged.length, 2);
});

test('incremental sync avoids re-embedding unchanged records', async () => {
  const first = makeDb();
  const hashes = new Map(first.records.map((record) => [record.sourceId, contentHash(record)]));
  const { db, state } = makeDb({ existingHashes: hashes });
  let embeddingCalls = 0;
  const manager = createSyncManager({
    db,
    probe: async () => ({ dimension: 3 }),
    embed: async () => { embeddingCalls += 1; return []; },
  });
  const started = manager.start(config());
  const finished = await waitForTerminal(manager, started.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.changed, 0);
  assert.equal(embeddingCalls, 0);
  assert.equal(state.staged.length, 0);
  assert.equal(state.committed, 'incremental');
});

test('cancelling during embedding drops staging and keeps the live index untouched', async () => {
  const { db, state } = makeDb();
  const manager = createSyncManager({
    db,
    probe: async () => ({ dimension: 3 }),
    embed: async ({ texts }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  });
  const started = manager.start(config());
  await new Promise((resolve) => setTimeout(resolve, 5));
  manager.cancel(started.id);
  const finished = await waitForTerminal(manager, started.id);
  assert.equal(finished.status, 'cancelled');
  assert.equal(state.committed, null);
  assert.equal(state.dropped, true);
});
