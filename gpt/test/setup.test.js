const test = require('node:test');
const assert = require('node:assert/strict');
const { provisionDatabases, statusDefaults, identifier, clientConfig } = require('../src/setup');

test('database setup is restricted to explicit loopback administrator fields', () => {
  assert.equal(identifier('universal_qa_index'), '"universal_qa_index"');
  assert.throws(() => identifier('index; DROP DATABASE postgres'), /safe PostgreSQL identifier/);
  assert.throws(() => clientConfig({ host: 'db.example.com', user: 'admin' }, 'postgres'), /local PostgreSQL/);
  assert.throws(() => clientConfig({ connectionString: 'postgres://localhost/postgres' }, 'postgres'), /explicit local host fields/);
  assert.ok(statusDefaults().adminConnection.user);
});

test('provisioning creates only the fixed GPT roles, grants, database, and schema', async () => {
  const clients = [];
  class FakeClient {
    constructor(config) { this.config = config; this.queries = []; clients.push(this); }
    async connect() {}
    async end() {}
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      if (/FROM pg_roles/u.test(sql)) return { rows: [{ exists: false }] };
      if (/FROM pg_database/u.test(sql)) return { rows: [{ exists: values[0] === 'universal_qa_index' }] };
      if (/to_regclass/u.test(sql)) return { rows: [{
        corpus: 'semantic_qa.corpus', records: 'semantic_qa.records', passages: 'semantic_qa.passages',
        answer_units: 'semantic_qa.answer_units', discovery_passages: 'semantic_qa.discovery_passages', source_aliases: 'semantic_qa.source_aliases',
      }] };
      if (/retrieval_schema_version/u.test(sql)) return { rows: [{ version: 'answer-unit-v5' }] };
      if (/SELECT DISTINCT tableowner/u.test(sql)) return { rows: [{ tableowner: 'semantic_qa_indexer' }] };
      return { rows: [] };
    }
  }
  const result = await provisionDatabases({
    adminConnection: { host: '127.0.0.1', port: 5433, user: 'admin', password: '', sslMode: 'disable' },
    indexDatabase: 'universal_qa_index',
  }, { ClientClass: FakeClient });
  assert.equal(result.indexRole, 'spiritual_gpt_index_reader');
  assert.equal(result.chatRole, 'spiritual_gpt_app');
  assert.deepEqual(clients.map((client) => client.config.database), ['postgres', 'universal_qa_index', 'spiritual_gpt']);
  const sql = clients.flatMap((client) => client.queries.map((query) => query.sql)).join('\n');
  assert.match(sql, /CREATE DATABASE "spiritual_gpt"/u);
  assert.match(sql, /GRANT SELECT ON semantic_qa\.corpus, semantic_qa\.records, semantic_qa\.passages, semantic_qa\.answer_units, semantic_qa\.discovery_passages, semantic_qa\.source_aliases/u);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS "gpt" AUTHORIZATION "spiritual_gpt_app"/u);
});
