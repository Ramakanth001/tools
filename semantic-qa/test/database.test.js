const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTextPhraseQueries, commitIncremental, connectionToPoolConfig, preserveLegacyAliases, searchAllPassages, searchPassages, searchRecords, searchTextRecords } = require('../src/database');

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

test('prefer SSL does not force TLS for loopback PostgreSQL', () => {
  assert.equal(connectionToPoolConfig({ host: '127.0.0.1', user: 'postgres', database: 'postgres', sslMode: 'prefer' }).ssl, false);
  assert.deepEqual(connectionToPoolConfig({ host: 'db.example.com', user: 'postgres', database: 'postgres', sslMode: 'prefer' }).ssl, { rejectUnauthorized: false });
});

test('conventional search extracts quoted and saying phrases without inventing terms', () => {
  const phrases = buildTextPhraseQueries('What is the meaning of Jesus saying "The light is in me"?');
  assert.equal(phrases[0], 'The light is in me');
  assert.ok(phrases.includes('Jesus saying "The light is in me'));
  assert.equal(phrases.some((phrase) => /universal|qualified monism/iu.test(phrase)), false);
});

test('incremental commit reconciles deleted source IDs inside one transaction', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const statement = compactSql(sql);
      statements.push(statement);
      if (statement.includes('to_regclass')) return { rows: [{ exists: false }] };
      return { rows: [] };
    },
  };
  await commitIncremental(client, {
    names: { stage: 'stage_job', passages: 'passages_job', answerUnits: 'units_job', discovery: 'discovery_job', aliases: 'aliases_job', seen: 'seen_job' },
    mapping: { schema: 'public', table: 'qa' },
    model: 'embeddinggemma', dimension: 768, formatVersion: 'embeddinggemma-asymmetric-v2', retrievalVersion: 'hybrid-v2',
    ollamaBaseUrl: 'http://127.0.0.1:11434', total: 10,
  });
  assert.equal(statements[0], 'BEGIN');
  assert.ok(statements.some((sql) => sql.includes('DELETE FROM semantic_qa.records') && sql.includes('NOT EXISTS')));
  assert.ok(statements.some((sql) => sql.includes('embedding_model_digest')));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('full rebuild carries forward prior v5 aliases and orphaned v4 chunk locators', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const statement = compactSql(sql);
      statements.push(statement);
      if (statement.includes('to_regclass')) return { rows: [{ exists: true }] };
      return { rows: [] };
    },
  };
  await preserveLegacyAliases(client, {
    stage: 'stage_job', aliases: 'aliases_job', answerUnits: 'units_job',
  }, { includeV4Records: true });
  assert.ok(statements.some((sql) => sql.includes('FROM semantic_qa.source_aliases old')));
  assert.ok(statements.some((sql) => sql.includes('FROM semantic_qa.records legacy')));
  assert.ok(statements.every((sql) => !sql.includes('DELETE FROM semantic_qa.source_aliases')));
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

test('passage search compares the query against answer passages and joins source records', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = compactSql(sql);
      calls.push({ statement, params });
      if (statement.includes('SELECT extversion FROM pg_extension')) return { rows: [{ extversion: '0.8.0' }] };
      if (statement.includes('JOIN semantic_qa.passages p')) {
        return { rows: [{ sourceId: 'answer:1', passageIndex: 2, passageText: 'Relevant answer.', similarity: 0.73 }] };
      }
      return { rows: [] };
    },
  };
  const result = await searchPassages(client, { id: 'default' }, [0.2, 0.8], 'meaning OR light', 60);
  const searchCall = calls.find((call) => call.statement.includes('JOIN semantic_qa.passages p'));
  assert.match(searchCall.statement, /FROM semantic_qa\.passages/);
  assert.match(searchCall.statement, /PARTITION BY source_id/);
  assert.match(searchCall.statement, /JOIN semantic_qa\.records r/);
  assert.deepEqual(searchCall.params, ['[0.2,0.8]', 'meaning OR light', 60, 240]);
  assert.equal(result.unit, 'answer_passage');
  assert.equal(result.rows[0].sourceId, 'answer:1');
  assert.equal(calls.at(-1).statement, 'COMMIT');
});

test('deep semantic retrieval scores the complete passage corpus but bounds returned rows', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = compactSql(sql);
      calls.push({ statement, params });
      return { rows: [{ sourceId: 'answer:1', passageText: 'Mula Maya is the original cause.', scannedPassages: 19777 }] };
    },
  };
  const result = await searchAllPassages(client, { id: 'default' }, [0.2, 0.8], 'mula OR maya', 0.31, 180);
  const search = calls[0];
  assert.match(search.statement, /all_scored AS MATERIALIZED/);
  assert.match(search.statement, /FROM semantic_qa\.passages/);
  assert.match(search.statement, /LIMIT \$4/);
  assert.deepEqual(search.params, ['[0.2,0.8]', 'mula OR maya', 0.31, 180]);
  assert.equal(result.exhaustive, true);
  assert.equal(result.scannedPassages, 19777);
  assert.equal(result.rows[0].scannedPassages, undefined);
});

test('conventional text search fuses exact, full-text, and trigram passage channels', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = compactSql(sql);
      calls.push({ statement, params });
      if (statement.includes('ranked.rrf_score')) return { rows: [{ sourceId: 'answer:1', matchChannels: ['exact passage', 'full text'] }] };
      return { rows: [] };
    },
  };
  const result = await searchTextRecords(client, { id: 'default' }, 'light is in me', 20);
  const search = calls.find((call) => call.statement.includes('ranked.rrf_score'));
  assert.match(search.statement, /exact_passage/);
  assert.match(search.statement, /full_text_passage/);
  assert.match(search.statement, /fuzzy_passage/);
  assert.match(search.statement, /word_similarity/);
  assert.match(search.statement, /sum\(weight \/ \(60\.0 \+ rank\)\)/);
  assert.deepEqual(search.params, ['light is in me', 20, 'light', ['light is in me']]);
  assert.equal(result.unit, 'text_passage');
  assert.equal(calls.at(-1).statement, 'COMMIT');
});
