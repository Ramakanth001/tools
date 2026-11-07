const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSettings, configured } = require('../src/config');
const { poolConfig } = require('../src/postgres');

test('normal runtime settings never acquire an accidental benchmark seed', () => {
  assert.equal(mergeSettings({ benchmarkSeed: null }).benchmarkSeed, null);
  assert.equal(mergeSettings({ benchmarkSeed: 29 }).benchmarkSeed, 29);
});

test('legacy oversized contexts migrate to the memory-safe local default', () => {
  const settings = mergeSettings({ contextTokens: 24576 });
  assert.equal(settings.contextTokens, 8192);
  assert.equal(settings.unloadAfterTurn, false);
  assert.equal(mergeSettings({ contextTokens: 12288 }).contextTokens, 12288);
});

test('response temperature is restricted to supported accuracy-conscious presets', () => {
  assert.equal(mergeSettings({ responseTemperature: 0.1 }).responseTemperature, 0.1);
  assert.equal(mergeSettings({ responseTemperature: 0.7 }).responseTemperature, 0.7);
  assert.equal(mergeSettings({ responseTemperature: 1.5 }).responseTemperature, 0.3);
  assert.equal(mergeSettings({ responseTemperature: 'random' }).responseTemperature, 0.3);
});

test('corpus pool is forced read-only with a short statement timeout', () => {
  const config = poolConfig({ host: '127.0.0.1', user: 'reader', database: 'index', sslMode: 'disable' }, { readOnly: true });
  assert.match(config.options, /default_transaction_read_only=on/);
  assert.match(config.options, /statement_timeout=15000/);
  assert.equal(config.ssl, false);
});

test('setup remains incomplete until an allowed model is explicitly selected', () => {
  const settings = mergeSettings({
    indexConnection: { host: '127.0.0.1', user: 'reader', database: 'index' },
    chatConnection: { host: '127.0.0.1', user: 'app', database: 'chat' },
  });
  assert.equal(configured(settings), false);
  assert.equal(configured(mergeSettings({ chatModel: 'qwen3:14b-q8_0' }, settings)), true);
});

test('the stale source-database GPT configuration migrates to the read-only vector index', () => {
  const settings = mergeSettings({ indexConnection: {
    host: '127.0.0.1', port: 5433, database: 'universal_qa_source', user: 'semantic_qa_reader', password: 'stale',
  } });
  assert.equal(settings.indexConnection.database, 'universal_qa_index');
  assert.equal(settings.indexConnection.user, 'spiritual_gpt_index_reader');
  assert.equal(settings.indexConnection.password, '');
});
