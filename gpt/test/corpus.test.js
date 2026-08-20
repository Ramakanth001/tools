const test = require('node:test');
const assert = require('node:assert/strict');
const { CorpusReader, quotedPhrases, toVectorLiteral, sameFingerprint } = require('../src/corpus');

test('query literals and exact phrases are normalized defensively', () => {
  assert.equal(toVectorLiteral([0, 1.5, -2]), '[0,1.5,-2]');
  assert.throws(() => toVectorLiteral([0, Number.NaN]), /invalid/);
  assert.deepEqual(quotedPhrases('What does “The light is in me” mean?'), ['The light is in me']);
  assert.deepEqual(quotedPhrases('What is the best way to reach God?'), []);
});

test('probe fusion deduplicates passages and caps each source group at three', () => {
  const reader = new CorpusReader();
  const rows = Array.from({ length: 5 }, (_, index) => ({
    sourceId: `s${index}`, sourceGroup: 'one-book', passageIndex: 0, similarity: 0.9 - index * 0.01,
    lexicalScore: 0.1, channels: ['dense'],
  }));
  const fused = reader.fuseProbeResults([
    { probe: { text: 'first', purpose: 'primary' }, rows },
    { probe: { text: 'second', purpose: 'relationship' }, rows: [rows[0]] },
  ]);
  assert.equal(fused.length, 3);
  assert.equal(fused[0].sourceId, 's0');
  assert.equal(fused[0].probes.length, 2);
});

test('evidence identity validation rejects offsets that do not reproduce the excerpt', async () => {
  const reader = new CorpusReader();
  reader.holder.pool = { query: async () => ({ rows: [{ sourceId: 's1', answer: 'before exact evidence after' }] }) };
  await assert.doesNotReject(() => reader.validateEvidence([{ evidenceId: 'E1', sourceId: 's1', start: 7, end: 21, excerpt: 'exact evidence' }]));
  await assert.rejects(() => reader.validateEvidence([{ evidenceId: 'E1', sourceId: 's1', start: 7, end: 21, excerpt: 'different text' }]), /no longer matches/);
});

test('corpus fingerprints include index identity and synchronization state', () => {
  const base = { retrievalSchemaVersion: 'passage-v4', embeddingFormatVersion: 'embeddinggemma-asymmetric-v3', embeddingModel: 'embeddinggemma', embeddingModelDigest: 'd', embeddingDimension: 768, recordCount: 10, lastSyncedAt: '2026-01-01T00:00:00Z' };
  assert.equal(sameFingerprint(base, { ...base }), true);
  assert.equal(sameFingerprint(base, { ...base, recordCount: 11 }), false);
});

test('context expansion casts arithmetic parameters for PostgreSQL', async () => {
  const reader = new CorpusReader();
  let statement = '';
  reader.holder.pool = { query: async (sql) => { statement = sql; return { rows: [] }; } };
  await reader.expandEvidence({ sourceId: 's1', passageIndex: 2 }, 1);
  assert.match(statement, /\$2::integer - \$3::integer/);
  assert.match(statement, /\$2::integer \+ \$3::integer/);
});
