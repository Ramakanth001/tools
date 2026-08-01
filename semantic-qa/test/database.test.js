const test = require('node:test');
const assert = require('node:assert/strict');
const { commitIncremental, connectionToPoolConfig, searchRecords } = require('../src/database');

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

test('prefer SSL does not force TLS for loopback PostgreSQL', () => {
  assert.equal(connectionToPoolConfig({ host: '127.0.0.1', user: 'postgres', database: 'postgres', sslMode: 'prefer' }).ssl, false);
  assert.deepEqual(connectionToPoolConfig({ host: 'db.example.com', user: 'postgres', database: 'postgres', sslMode: 'prefer' }).ssl, { rejectUnauthorized: false });
});

test('incremental commit reconciles deleted source IDs inside one transaction', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(compactSql(sql));
      return { rows: [] };
    },
  };
  await commitIncremental(client, {
    names: { stage: 'stage_job', seen: 'seen_job' },
    mapping: { schema: 'public', table: 'qa' },
    model: 'embeddinggemma', dimension: 768, formatVersion: 'embeddinggemma-asymmetric-v2', retrievalVersion: 'hybrid-v2',
    ollamaBaseUrl: 'http://127.0.0.1:11434', total: 10,
  });
  assert.equal(statements[0], 'BEGIN');
  assert.ok(statements.some((sql) => sql.includes('DELETE FROM semantic_qa.records') && sql.includes('NOT EXISTS')));
  assert.ok(statements.some((sql) => sql.includes('embedding_model_digest')));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('hybrid search oversamples HNSW and diversifies both pools by explicit chunk group', async () => {
  const corpus = { id: 'default' };
  const candidateRows = Array.from({ length: 30 }, (_, index) => ({
    sourceId: `group-${index}:candidate`,
    question: `Question ${index}`,
    answer: `Answer ${index}`,
    metadata: { chunk_count: 3 },
    sourceGroup: `group-${String(index).padStart(2, '0')}`,
    sourceOrder: 2,
    similarity: 1 - index / 100,
    lexicalScore: 0,
  }));
  candidateRows.push(
    {
      sourceId: 'ungrouped-a',
      question: 'Repeated title',
      answer: 'First independent answer',
      metadata: {},
      sourceGroup: null,
      sourceOrder: null,
      similarity: 0.5,
      lexicalScore: 0.1,
    },
    {
      sourceId: 'ungrouped-b',
      question: 'Repeated title',
      answer: 'Second independent answer',
      metadata: {},
      sourceGroup: null,
      sourceOrder: null,
      similarity: 0.49,
      lexicalScore: 0.1,
    },
    {
      sourceId: 'category-a',
      question: 'Category member A',
      answer: 'First category answer',
      metadata: {},
      sourceGroup: 'shared-category',
      sourceOrder: 1,
      similarity: 0.48,
      lexicalScore: 0,
    },
    {
      sourceId: 'category-b',
      question: 'Category member B',
      answer: 'Second category answer',
      metadata: {},
      sourceGroup: 'shared-category',
      sourceOrder: 2,
      similarity: 0.47,
      lexicalScore: 0,
    },
  );
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = compactSql(sql);
      calls.push({ statement, params });
      if (statement.includes('SELECT extversion FROM pg_extension')) {
        return { rows: [{ extversion: '0.8.0' }] };
      }
      if (statement.includes('candidates AS (SELECT source_id FROM dense UNION SELECT source_id FROM lexical)')) {
        return { rows: candidateRows };
      }
      if (statement.includes('ranked_siblings AS MATERIALIZED')) {
        return {
          rows: [
            { ...candidateRows[0], answer: 'Expanded canonical answer', sourceOrder: 1 },
            {
              sourceId: 'group-00:sibling',
              question: 'Question 0',
              answer: 'Sibling answer',
              metadata: { chunk_count: 3 },
              sourceGroup: 'group-00',
              sourceOrder: 3,
              similarity: 0.8,
              lexicalScore: 0.2,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const result = await searchRecords(client, corpus, [0.1, 0.2], 'alpha beta', 60, true);
  const candidateCall = calls.find((call) => call.statement.includes('candidates AS (SELECT source_id FROM dense UNION SELECT source_id FROM lexical)'));
  const siblingCall = calls.find((call) => call.statement.includes('ranked_siblings AS MATERIALIZED'));

  assert.ok(calls.some((call) => call.statement === 'SET LOCAL hnsw.ef_search = 240'));
  assert.ok(calls.some((call) => call.statement === "SET LOCAL hnsw.iterative_scan = 'strict_order'"));
  assert.deepEqual(candidateCall.params, ['[0.1,0.2]', 'alpha beta', 60, 240]);
  assert.equal(
    candidateCall.statement.match(/PARTITION BY document_group, CASE WHEN document_group IS NULL THEN source_id END/g)?.length,
    2,
  );
  assert.match(candidateCall.statement, /metadata->>'chunk_count'/);
  assert.equal(siblingCall.params[2].length, 24);
  assert.equal(siblingCall.params[2].includes('shared-category'), false);
  assert.deepEqual(siblingCall.params.slice(3), [1200, 100]);
  assert.equal(result.rows.filter((row) => row.sourceId === candidateRows[0].sourceId).length, 1);
  assert.equal(result.rows.find((row) => row.sourceId === candidateRows[0].sourceId).answer, 'Expanded canonical answer');
  assert.equal(result.rows.filter((row) => row.sourceGroup == null).length, 2);
  assert.equal(result.rows.filter((row) => row.sourceGroup === 'shared-category').length, 2);
  assert.equal(result.hybrid, true);
  assert.equal(calls.at(-1).statement, 'COMMIT');
});

test('dense search bounds raw work and skips iterative scan on older pgvector', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = compactSql(sql);
      calls.push({ statement, params });
      if (statement.includes('SELECT extversion FROM pg_extension')) {
        return { rows: [{ extversion: '0.7.4' }] };
      }
      return { rows: [] };
    },
  };

  const result = await searchRecords(client, { id: 'default' }, [1, 0], 'query', 10000, false);
  const candidateCall = calls.find((call) => call.statement.includes('WITH dense_raw AS MATERIALIZED'));

  assert.ok(calls.some((call) => call.statement === 'SET LOCAL hnsw.ef_search = 800'));
  assert.equal(calls.some((call) => call.statement.includes('hnsw.iterative_scan')), false);
  assert.deepEqual(candidateCall.params, ['[1,0]', 200, 800]);
  assert.match(candidateCall.statement, /PARTITION BY document_group, CASE WHEN document_group IS NULL THEN source_id END/);
  assert.deepEqual(result.rows, []);
  assert.equal(result.hybrid, false);
  assert.equal(calls.at(-1).statement, 'COMMIT');
});
