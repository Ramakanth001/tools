const test = require('node:test');
const assert = require('node:assert/strict');
const { commitIncremental, connectionToPoolConfig } = require('../src/database');

test('prefer SSL does not force TLS for loopback PostgreSQL', () => {
  assert.equal(connectionToPoolConfig({ host: '127.0.0.1', user: 'postgres', database: 'postgres', sslMode: 'prefer' }).ssl, false);
  assert.deepEqual(connectionToPoolConfig({ host: 'db.example.com', user: 'postgres', database: 'postgres', sslMode: 'prefer' }).ssl, { rejectUnauthorized: false });
});

test('incremental commit reconciles deleted source IDs inside one transaction', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(String(sql).replace(/\s+/g, ' ').trim());
      return { rows: [] };
    },
  };
  await commitIncremental(client, {
    names: { stage: 'stage_job', seen: 'seen_job' },
    mapping: { schema: 'public', table: 'qa' },
    model: 'embeddinggemma', dimension: 768,
    ollamaBaseUrl: 'http://127.0.0.1:11434', total: 10,
  });
  assert.equal(statements[0], 'BEGIN');
  assert.ok(statements.some((sql) => sql.includes('DELETE FROM semantic_qa.records') && sql.includes('NOT EXISTS')));
  assert.equal(statements.at(-1), 'COMMIT');
});
