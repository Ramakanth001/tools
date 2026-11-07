const assert = require('node:assert/strict');
const database = require('../src/database');
const { embeddingFormatForModel, RETRIEVAL_SCHEMA_VERSION } = require('../src/core');
const { sha256 } = require('../src/corpusStructure');

const databaseName = String(process.env.SEMANTIC_QA_VALIDATION_DATABASE || '');
if (!/^semantic_qa_v5_validation_[a-z0-9_]+$/u.test(databaseName)) {
  throw new Error('SEMANTIC_QA_VALIDATION_DATABASE must name a disposable semantic_qa_v5_validation_* database');
}

const connection = {
  connectionString: '',
  host: process.env.SEMANTIC_QA_VALIDATION_HOST || '127.0.0.1',
  port: Number(process.env.SEMANTIC_QA_VALIDATION_PORT || 5433),
  user: process.env.SEMANTIC_QA_VALIDATION_USER || 'ramakanth',
  password: process.env.SEMANTIC_QA_VALIDATION_PASSWORD || '',
  database: databaseName,
  sslMode: 'disable',
};
const model = 'embeddinggemma';
const modelDigest = 'validation-digest';
const formatVersion = embeddingFormatForModel(model);
const vector = [1, 0, 0];

function commitPayload(names, total = 1) {
  return {
    names,
    mapping: { schema: 'public', table: 'corpus_documents' },
    model,
    modelDigest,
    dimension: 3,
    formatVersion,
    retrievalVersion: RETRIEVAL_SCHEMA_VERSION,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    total,
  };
}

async function stageDocument(client, names, { sourceId, answer, citationText = answer }) {
  const answerUnitId = `${sourceId}:teaching:1`;
  await database.insertSeen(client, names.seen, [sourceId]);
  await database.insertStageRecords(client, names.stage, [{
    sourceId,
    question: 'Validation teaching',
    answer,
    metadata: { source_type: 'discourse', author: 'Swami', raw_content_hash: sha256(answer), display_text_hash: sha256(answer) },
    sourceGroup: sourceId,
    sourceOrder: null,
    contentHash: sha256(answer),
    embedding: vector,
  }]);
  await database.insertStageAnswerUnits(client, names.answerUnits, [{
    answerUnitId,
    sourceId,
    unitIndex: 1,
    unitKind: 'swami_teaching',
    author: 'Swami',
    associatedQuestion: '',
    language: 'ENG',
    start: 0,
    end: answer.length,
    text: answer,
    contentHash: sha256(answer),
    contextComplete: true,
  }]);
  await database.insertStagePassages(client, names.passages, [{
    sourceId,
    passageIndex: 0,
    answerUnitId,
    text: answer,
    start: 0,
    end: answer.length,
    citationStart: 0,
    citationEnd: answer.length,
    citationText,
    author: 'Swami',
    unitKind: 'swami_teaching',
    associatedQuestion: '',
    contextComplete: true,
    storyComplete: true,
    embedding: vector,
  }]);
  await database.insertStageDiscoveryPassages(client, names.discovery, [{
    sourceId, discoveryIndex: 0, text: 'Validation teaching', embedding: vector,
  }]);
  await database.insertStageAliases(client, names.aliases, [{
    aliasId: `${sourceId}:001`, sourceId, answerUnitId,
  }]);
}

async function run() {
  await database.initializeIndex(connection, {
    model, modelDigest, dimension: 3, ollamaBaseUrl: 'http://127.0.0.1:11434',
  });

  await database.withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("UPDATE semantic_qa.corpus SET retrieval_schema_version = 'passage-v4' WHERE id = 'default'");
      const names = await database.createSyncStage(client, 'validation_promote', 3);
      await stageDocument(client, names, { sourceId: 'discourse:validation', answer: 'Do your duty 💠 without attachment.' });
      await database.commitRebuild(client, commitPayload(names));
      const rollback = await client.query(`
        SELECT to_regclass('semantic_qa.records_v4_rollback') IS NOT NULL AS records,
               to_regclass('semantic_qa.passages_v4_rollback') IS NOT NULL AS passages
      `);
      assert.deepEqual(rollback.rows[0], { records: true, passages: true });
    } finally {
      client.release();
    }
  });

  const status = await database.getIndexStatus(connection);
  assert.equal(status.corpus.retrievalSchemaVersion, RETRIEVAL_SCHEMA_VERSION);
  assert.equal(status.recordCount, 1);
  assert.equal(status.passageCount, 1);
  const units = await database.getAnswerUnits(connection, ['discourse:validation:001']);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, 'Do your duty 💠 without attachment.');
  assert.equal(units[0].displayText.slice(units[0].start, units[0].end), units[0].text);
  const dense = await database.searchPassageIndex(connection, vector, 'validation OR duty', 10);
  assert.ok(dense.rows.some((row) => row.sourceId === 'discourse:validation'));
  assert.ok(dense.rows.every((row) => row.author === 'Swami' && row.citationText));
  const lexical = await database.searchTextIndex(connection, 'validation teaching', 10);
  assert.ok(lexical.rows.some((row) => row.sourceId === 'discourse:validation'));

  await database.withPool(connection, async (pool) => {
    const client = await pool.connect();
    let names;
    try {
      names = await database.createSyncStage(client, 'validation_rollback', 3);
      await stageDocument(client, names, {
        sourceId: 'discourse:invalid',
        answer: 'Exact source text.',
        citationText: 'Model-authored text',
      });
      await assert.rejects(
        () => database.commitRebuild(client, commitPayload(names)),
        /Verbatim offset validation failed/u,
      );
      const preserved = await client.query('SELECT source_id, answer FROM semantic_qa.records ORDER BY source_id');
      assert.deepEqual(preserved.rows, [{ source_id: 'discourse:validation', answer: 'Do your duty 💠 without attachment.' }]);
    } finally {
      if (names) await database.dropSyncStage(client, names);
      client.release();
    }
  });

  process.stdout.write(`${JSON.stringify({ ok: true, database: databaseName, retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION, atomicRollbackVerified: true }, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
