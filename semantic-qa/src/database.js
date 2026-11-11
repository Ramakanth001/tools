const { requireToolDep } = require('../requireToolDep');
const {
  quoteIdentifier,
  assertIdentifier,
  toVectorLiteral,
  buildLexicalQuery,
  embeddingFormatForModel,
  RETRIEVAL_SCHEMA_VERSION,
} = require('./core');

const { Pool } = requireToolDep('pg');

function connectionToPoolConfig(connection = {}) {
  const common = {
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'semantic-qa',
  };
  if (String(connection.connectionString || '').trim()) {
    return { ...common, connectionString: String(connection.connectionString).trim() };
  }
  const sslMode = String(connection.sslMode || 'prefer');
  const host = String(connection.host || '127.0.0.1');
  const normalizedHost = host.trim().toLowerCase();
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(normalizedHost);
  let ssl;
  if (sslMode === 'disable') ssl = false;
  else if (sslMode === 'prefer') ssl = loopback ? false : { rejectUnauthorized: false };
  else if (['require', 'no-verify'].includes(sslMode)) ssl = { rejectUnauthorized: false };
  else ssl = { rejectUnauthorized: true };
  return {
    ...common,
    host,
    port: Number(connection.port || 5432),
    user: String(connection.user || ''),
    password: String(connection.password || ''),
    database: String(connection.database || 'postgres'),
    ssl,
  };
}

function createPool(connection) {
  return new Pool(connectionToPoolConfig(connection));
}

function buildTextPhraseQueries(value) {
  const raw = String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const phrases = [];
  const add = (candidate) => {
    const phrase = String(candidate || '').trim().replace(/^[\s"'‘’“”:,-]+|[\s"'‘’“”?.!,;:-]+$/gu, '');
    const wordCount = phrase.match(/[\p{L}\p{N}]+/gu)?.length || 0;
    if (phrase.length >= 8 && phrase.length <= 180 && wordCount >= 2 && !phrases.some((item) => item.toLocaleLowerCase() === phrase.toLocaleLowerCase())) {
      phrases.push(phrase);
    }
  };
  for (const match of raw.matchAll(/["“]([^"”]{3,})["”]|'([^']{3,})'/gu)) add(match[1] || match[2]);
  for (const match of raw.matchAll(/\b(?:saying|said|phrase|statement|words|meaning)\b(?:\s+of|\s+that)?\s+/giu)) {
    add(raw.slice(Number(match.index) + match[0].length));
  }
  if ((raw.match(/[\p{L}\p{N}]+/gu)?.length || 0) <= 12) add(raw);
  return phrases.slice(0, 5);
}

async function withPool(connection, callback) {
  const pool = createPool(connection);
  try {
    return await callback(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function testPostgresConnection(connection) {
  return withPool(connection, async (pool) => {
    const result = await pool.query('SELECT current_database() AS database, current_user AS "user", version() AS version');
    return result.rows[0];
  });
}

async function discoverSourceCatalog(connection) {
  return withPool(connection, async (pool) => {
    const result = await pool.query(`
      SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column,
             c.data_type AS "dataType", c.is_nullable = 'YES' AS nullable,
             EXISTS (
               SELECT 1
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage ku
                 ON ku.constraint_name = tc.constraint_name
                AND ku.constraint_schema = tc.constraint_schema
               WHERE tc.constraint_type = 'PRIMARY KEY'
                 AND tc.table_schema = c.table_schema
                 AND tc.table_name = c.table_name
                 AND ku.column_name = c.column_name
             ) AS "primaryKey"
      FROM information_schema.columns c
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'semantic_qa')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `);
    const schemas = new Map();
    for (const row of result.rows) {
      if (!schemas.has(row.schema)) schemas.set(row.schema, new Map());
      const tables = schemas.get(row.schema);
      if (!tables.has(row.table)) tables.set(row.table, []);
      tables.get(row.table).push({
        name: row.column,
        dataType: row.dataType,
        nullable: row.nullable,
        primaryKey: row.primaryKey,
      });
    }
    return [...schemas.entries()].map(([name, tables]) => ({
      name,
      tables: [...tables.entries()].map(([tableName, columns]) => ({ name: tableName, columns })),
    }));
  });
}

function validateMapping(mapping) {
  const normalized = {
    schema: assertIdentifier(mapping?.schema, 'Schema'),
    table: assertIdentifier(mapping?.table, 'Table'),
    idColumn: assertIdentifier(mapping?.idColumn, 'ID column'),
    questionColumn: assertIdentifier(mapping?.questionColumn, 'Question column'),
    answerColumn: assertIdentifier(mapping?.answerColumn, 'Answer column'),
    metadataColumns: [...new Set((mapping?.metadataColumns || []).map((value) => assertIdentifier(value, 'Metadata column')))],
    groupColumn: mapping?.groupColumn ? assertIdentifier(mapping.groupColumn, 'Group column') : null,
    orderColumn: mapping?.orderColumn ? assertIdentifier(mapping.orderColumn, 'Order column') : null,
  };
  const reserved = new Set([normalized.idColumn, normalized.questionColumn, normalized.answerColumn]);
  normalized.metadataColumns = normalized.metadataColumns.filter((column) => !reserved.has(column));
  return normalized;
}

async function openSourceSnapshot(connection, mapping) {
  const normalized = validateMapping(mapping);
  const pool = createPool(connection);
  const client = await pool.connect();
  const schema = quoteIdentifier(normalized.schema);
  const table = quoteIdentifier(normalized.table);
  const id = quoteIdentifier(normalized.idColumn);
  const question = quoteIdentifier(normalized.questionColumn);
  const answer = quoteIdentifier(normalized.answerColumn);

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const preflight = await client.query(`
      SELECT COUNT(*)::bigint AS total,
             COUNT(${id})::bigint AS non_null_ids,
             COUNT(DISTINCT ${id})::bigint AS distinct_ids,
             COUNT(*) FILTER (WHERE ${question} IS NULL OR btrim(${question}::text) = '')::bigint AS invalid_questions,
             COUNT(*) FILTER (WHERE ${answer} IS NULL OR btrim(${answer}::text) = '')::bigint AS invalid_answers
      FROM ${schema}.${table}
    `);
    const counts = Object.fromEntries(Object.entries(preflight.rows[0]).map(([key, value]) => [key, Number(value)]));
    if (counts.total !== counts.non_null_ids) throw new Error('Source ID column contains null values');
    if (counts.total !== counts.distinct_ids) throw new Error('Source ID column must be unique');
    if (counts.invalid_questions) throw new Error(`${counts.invalid_questions} source records have an empty question`);
    if (counts.invalid_answers) throw new Error(`${counts.invalid_answers} source records have an empty answer`);

    const selections = [
      `${id}::text AS "__source_id"`,
      `${question}::text AS "__question"`,
      `${answer}::text AS "__answer"`,
      ...normalized.metadataColumns.map((column, index) => `${quoteIdentifier(column)} AS "__metadata_${index}"`),
      normalized.groupColumn ? `${quoteIdentifier(normalized.groupColumn)}::text AS "__source_group"` : `NULL::text AS "__source_group"`,
      normalized.orderColumn ? `${quoteIdentifier(normalized.orderColumn)} AS "__source_order"` : `NULL::text AS "__source_order"`,
    ];

    return {
      total: counts.total,
      mapping: normalized,
      async readBatch(offset, limit) {
        const result = await client.query(`
          SELECT ${selections.join(', ')}
          FROM ${schema}.${table}
          ORDER BY ${id}::text
          LIMIT $1 OFFSET $2
        `, [limit, offset]);
        return result.rows.map((row) => {
          const metadata = {};
          normalized.metadataColumns.forEach((column, index) => {
            metadata[column] = row[`__metadata_${index}`];
          });
          return {
            sourceId: row.__source_id,
            question: row.__question,
            answer: row.__answer,
            metadata,
            sourceGroup: row.__source_group,
            sourceOrder: row.__source_order,
          };
        });
      },
      async close(commit = true) {
        try {
          await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        } finally {
          client.release();
          await pool.end().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function ensureDimension(value) {
  const dimension = Number(value);
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 2000) {
    throw new Error('Embedding dimension must be between 1 and 2000 for pgvector HNSW');
  }
  return dimension;
}

async function ensureCoreSchema(client) {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await client.query('CREATE SCHEMA IF NOT EXISTS semantic_qa');
  await client.query(`
    CREATE TABLE IF NOT EXISTS semantic_qa.corpus (
      id text PRIMARY KEY,
      source_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
      embedding_model text NOT NULL,
      embedding_model_digest text,
      embedding_dimension integer NOT NULL,
      ollama_base_url text NOT NULL,
      record_count bigint NOT NULL DEFAULT 0,
      last_synced_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS semantic_qa.sync_runs (
      id text PRIMARY KEY,
      mode text NOT NULL,
      status text NOT NULL,
      processed bigint NOT NULL DEFAULT 0,
      changed bigint NOT NULL DEFAULT 0,
      total bigint NOT NULL DEFAULT 0,
      error text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )
  `);
  await client.query(`
    ALTER TABLE semantic_qa.corpus
    ADD COLUMN IF NOT EXISTS embedding_format_version text NOT NULL DEFAULT 'legacy-v1'
  `);
  await client.query(`
    ALTER TABLE semantic_qa.corpus
    ADD COLUMN IF NOT EXISTS retrieval_schema_version text NOT NULL DEFAULT 'dense-v1'
  `);
  await client.query(`
    ALTER TABLE semantic_qa.corpus
    ADD COLUMN IF NOT EXISTS embedding_model_digest text
  `);
}

async function recordsTableExists(client) {
  const result = await client.query(`SELECT to_regclass('semantic_qa.records') IS NOT NULL AS exists`);
  return result.rows[0].exists;
}

async function passagesTableExists(client) {
  const result = await client.query(`SELECT to_regclass('semantic_qa.passages') IS NOT NULL AS exists`);
  return result.rows[0].exists;
}

async function relationExists(client, relation) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`semantic_qa.${relation}`]);
  return result.rows[0].exists;
}

async function createRecordsTable(client, tableName, dimension, { unlogged = false } = {}) {
  const name = assertIdentifier(tableName, 'Index table');
  const dim = ensureDimension(dimension);
  await client.query(`
    CREATE ${unlogged ? 'UNLOGGED ' : ''}TABLE semantic_qa.${quoteIdentifier(name)} (
      source_id text PRIMARY KEY,
      question text NOT NULL,
      answer text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_group text,
      source_order jsonb,
      content_hash text NOT NULL,
      embedding vector(${dim}) NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, question), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(metadata->>'question_context', metadata->>'source_context', '')), 'B') ||
        setweight(to_tsvector('simple'::regconfig, answer), 'D')
      ) STORED,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function createPassagesTable(client, tableName, dimension, { unlogged = false } = {}) {
  const name = assertIdentifier(tableName, 'Passage index table');
  const dim = ensureDimension(dimension);
  await client.query(`
    CREATE ${unlogged ? 'UNLOGGED ' : ''}TABLE semantic_qa.${quoteIdentifier(name)} (
      source_id text NOT NULL,
      passage_index integer NOT NULL,
      answer_unit_id text NOT NULL,
      passage_text text NOT NULL,
      start_offset integer NOT NULL,
      end_offset integer NOT NULL,
      citation_start_offset integer NOT NULL,
      citation_end_offset integer NOT NULL,
      citation_text text NOT NULL,
      author text NOT NULL DEFAULT 'Swami',
      unit_kind text NOT NULL CHECK (unit_kind IN ('swami_reply', 'swami_teaching')),
      associated_question text NOT NULL DEFAULT '',
      context_complete boolean NOT NULL DEFAULT true,
      story_complete boolean NOT NULL DEFAULT true,
      embedding vector(${dim}) NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('simple'::regconfig, passage_text)
      ) STORED,
      PRIMARY KEY (source_id, passage_index),
      CHECK (start_offset >= 0 AND end_offset > start_offset),
      CHECK (citation_start_offset >= 0 AND citation_end_offset > citation_start_offset),
      CHECK (author = 'Swami')
    )
  `);
}

async function createAnswerUnitsTable(client, tableName, { unlogged = false } = {}) {
  const name = assertIdentifier(tableName, 'Answer unit table');
  await client.query(`
    CREATE ${unlogged ? 'UNLOGGED ' : ''}TABLE semantic_qa.${quoteIdentifier(name)} (
      answer_unit_id text PRIMARY KEY,
      source_id text NOT NULL,
      unit_index integer NOT NULL,
      unit_kind text NOT NULL CHECK (unit_kind IN ('swami_reply', 'swami_teaching')),
      author text NOT NULL CHECK (author = 'Swami'),
      associated_question text NOT NULL DEFAULT '',
      language text NOT NULL DEFAULT '',
      start_offset integer NOT NULL,
      end_offset integer NOT NULL,
      unit_text text NOT NULL,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      context_complete boolean NOT NULL DEFAULT true,
      UNIQUE (source_id, unit_index),
      CHECK (start_offset >= 0 AND end_offset > start_offset)
    )
  `);
}

async function createDiscoveryPassagesTable(client, tableName, dimension, { unlogged = false } = {}) {
  const name = assertIdentifier(tableName, 'Discovery passage table');
  const dim = ensureDimension(dimension);
  await client.query(`
    CREATE ${unlogged ? 'UNLOGGED ' : ''}TABLE semantic_qa.${quoteIdentifier(name)} (
      source_id text NOT NULL,
      discovery_index integer NOT NULL,
      discovery_text text NOT NULL,
      embedding vector(${dim}) NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, discovery_text)) STORED,
      PRIMARY KEY (source_id, discovery_index)
    )
  `);
}

async function createSourceAliasesTable(client, tableName, { unlogged = false } = {}) {
  const name = assertIdentifier(tableName, 'Source alias table');
  await client.query(`
    CREATE ${unlogged ? 'UNLOGGED ' : ''}TABLE semantic_qa.${quoteIdentifier(name)} (
      alias_id text PRIMARY KEY,
      source_id text NOT NULL,
      answer_unit_id text
    )
  `);
}

async function createHnswIndex(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_records_embedding_hnsw
      ON semantic_qa.records USING hnsw (embedding vector_cosine_ops)
  `);
}

async function createPassageIndexes(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_passages_embedding_hnsw
      ON semantic_qa.passages USING hnsw (embedding vector_cosine_ops)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_passages_search_gin
      ON semantic_qa.passages USING gin (search_vector)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_passages_source_id
      ON semantic_qa.passages (source_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_passages_text_trgm
      ON semantic_qa.passages USING gin (passage_text gin_trgm_ops)
  `);
}

async function createV5Indexes(client) {
  if (await relationExists(client, 'answer_units')) {
    await client.query('CREATE INDEX IF NOT EXISTS semantic_qa_answer_units_source_id ON semantic_qa.answer_units (source_id, unit_index)');
  }
  if (await relationExists(client, 'discovery_passages')) {
    await client.query('CREATE INDEX IF NOT EXISTS semantic_qa_discovery_embedding_hnsw ON semantic_qa.discovery_passages USING hnsw (embedding vector_cosine_ops)');
    await client.query('CREATE INDEX IF NOT EXISTS semantic_qa_discovery_search_gin ON semantic_qa.discovery_passages USING gin (search_vector)');
    await client.query('CREATE INDEX IF NOT EXISTS semantic_qa_discovery_text_trgm ON semantic_qa.discovery_passages USING gin (discovery_text gin_trgm_ops)');
  }
  if (await relationExists(client, 'source_aliases')) {
    await client.query('CREATE INDEX IF NOT EXISTS semantic_qa_source_aliases_source_id ON semantic_qa.source_aliases (source_id)');
  }
}

async function grantV5ReadAccess(client) {
  await client.query(`
    DO $grant$
    DECLARE role_name text;
    BEGIN
      FOREACH role_name IN ARRAY ARRAY['spiritual_gpt_index_reader', 'semantic_qa_reader'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format('GRANT USAGE ON SCHEMA semantic_qa TO %I', role_name);
          EXECUTE format('GRANT SELECT ON semantic_qa.corpus, semantic_qa.records, semantic_qa.passages, semantic_qa.answer_units, semantic_qa.discovery_passages, semantic_qa.source_aliases TO %I', role_name);
        END IF;
      END LOOP;
    END $grant$
  `);
}

async function searchVectorExists(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'semantic_qa.records'::regclass
        AND attname = 'search_vector' AND NOT attisdropped
    ) AS exists
  `);
  return result.rows[0].exists;
}

async function createSearchIndex(client) {
  if (!(await searchVectorExists(client))) return;
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_records_search_gin
      ON semantic_qa.records USING gin (search_vector)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_records_question_trgm
      ON semantic_qa.records USING gin (question gin_trgm_ops)
  `);
}

async function getCorpus(client) {
  const result = await client.query(`
    SELECT id, source_mapping AS "sourceMapping", embedding_model AS "embeddingModel",
           embedding_model_digest AS "embeddingModelDigest",
           embedding_dimension AS "embeddingDimension", embedding_format_version AS "embeddingFormatVersion",
           retrieval_schema_version AS "retrievalSchemaVersion",
           ollama_base_url AS "ollamaBaseUrl",
           record_count::bigint AS "recordCount", last_synced_at AS "lastSyncedAt", updated_at AS "updatedAt"
    FROM semantic_qa.corpus WHERE id = 'default'
  `);
  if (!result.rows[0]) return null;
  return { ...result.rows[0], recordCount: Number(result.rows[0].recordCount) };
}

async function initializeIndex(connection, { model, modelDigest = null, dimension, ollamaBaseUrl }) {
  return withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      await ensureCoreSchema(client);
      const existingCorpus = await getCorpus(client);
      const exists = await recordsTableExists(client);
      if (!exists) {
        await createRecordsTable(client, 'records', dimension);
      }
      if (!(await passagesTableExists(client))) {
        await createPassagesTable(client, 'passages', dimension);
      }
      if (!(await relationExists(client, 'answer_units'))) await createAnswerUnitsTable(client, 'answer_units');
      if (!(await relationExists(client, 'discovery_passages'))) await createDiscoveryPassagesTable(client, 'discovery_passages', dimension);
      if (!(await relationExists(client, 'source_aliases'))) await createSourceAliasesTable(client, 'source_aliases');
      await createHnswIndex(client);
      await createSearchIndex(client);
      await createPassageIndexes(client);
      await createV5Indexes(client);
      await grantV5ReadAccess(client);
      if (!existingCorpus) {
        const formatVersion = embeddingFormatForModel(model);
        await client.query(`
          INSERT INTO semantic_qa.corpus
            (id, source_mapping, embedding_model, embedding_model_digest, embedding_dimension,
             embedding_format_version, ollama_base_url)
          VALUES ('default', '{}'::jsonb, $1, $2, $3, $4, $5)
        `, [model, modelDigest, dimension, formatVersion, ollamaBaseUrl]);
      }
      const corpus = existingCorpus || await getCorpus(client);
      const requiresRebuild = corpus.embeddingModel !== model ||
        String(corpus.embeddingModelDigest || '') !== String(modelDigest || '') ||
        Number(corpus.embeddingDimension) !== Number(dimension) ||
        corpus.embeddingFormatVersion !== embeddingFormatForModel(model) ||
        corpus.retrievalSchemaVersion !== RETRIEVAL_SCHEMA_VERSION;
      return { initialized: true, requiresRebuild, corpus, recordsTable: true };
    } finally {
      client.release();
    }
  });
}

async function testIndexConnection(connection) {
  return withPool(connection, async (pool) => {
    const result = await pool.query(`
      SELECT current_database() AS database, current_user AS "user",
             (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS "vectorVersion"
    `);
    return result.rows[0];
  });
}

async function getIndexStatus(connection) {
  return withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      const schema = await client.query(`SELECT to_regnamespace('semantic_qa') IS NOT NULL AS exists`);
      if (!schema.rows[0].exists) return { initialized: false, corpus: null, recordCount: 0, recentRuns: [] };
      await ensureCoreSchema(client);
      const exists = await recordsTableExists(client);
      const passagesExist = await passagesTableExists(client);
      const corpus = await getCorpus(client);
      const count = exists ? await client.query('SELECT COUNT(*)::bigint AS count FROM semantic_qa.records') : { rows: [{ count: 0 }] };
      const passageCount = passagesExist
        ? await client.query('SELECT COUNT(*)::bigint AS count FROM semantic_qa.passages')
        : { rows: [{ count: 0 }] };
      const indexedDocsCount = passagesExist
        ? await client.query('SELECT COUNT(DISTINCT source_id)::bigint AS count FROM semantic_qa.passages')
        : { rows: [{ count: 0 }] };
      let checkpoint = null;
      const runs = await client.query(`
        SELECT id, mode, status, processed::bigint AS processed, changed::bigint AS changed,
               total::bigint AS total, error, started_at AS "startedAt", finished_at AS "finishedAt"
        FROM semantic_qa.sync_runs ORDER BY started_at DESC LIMIT 10
      `);
      return {
        indexedDocsCount: Number(indexedDocsCount.rows[0].count),
        checkpoint,
        initialized: Boolean(corpus && exists),
        corpus,
        recordCount: Number(count.rows[0].count),
        passageCount: Number(passageCount.rows[0].count),
        recentRuns: runs.rows.map((run) => ({
          ...run,
          processed: Number(run.processed),
          changed: Number(run.changed),
          total: Number(run.total),
        })),
      };
    } finally {
      client.release();
    }
  });
}

function stageNames(jobId) {
  const suffix = assertIdentifier(String(jobId).replace(/[^A-Za-z0-9_]/g, '_'), 'Job ID');
  return {
    stage: `records_stage_${suffix}`,
    passages: `passages_stage_${suffix}`,
    answerUnits: `answer_units_stage_${suffix}`,
    discovery: `discovery_stage_${suffix}`,
    aliases: `aliases_stage_${suffix}`,
    seen: `records_seen_${suffix}`,
  };
}

async function createSyncStage(client, jobId, dimension) {
  const names = stageNames(jobId);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.stage)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.passages)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.answerUnits)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.discovery)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.aliases)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.seen)}`);
  await createRecordsTable(client, names.stage, dimension, { unlogged: true });
  await createPassagesTable(client, names.passages, dimension, { unlogged: true });
  await createAnswerUnitsTable(client, names.answerUnits, { unlogged: true });
  await createDiscoveryPassagesTable(client, names.discovery, dimension, { unlogged: true });
  await createSourceAliasesTable(client, names.aliases, { unlogged: true });
  await client.query(`CREATE UNLOGGED TABLE semantic_qa.${quoteIdentifier(names.seen)} (source_id text PRIMARY KEY)`);
  return names;
}

async function dropSyncStage(client, names) {
  if (!names) return;
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.stage)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.passages)}`);
  if (names.answerUnits) await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.answerUnits)}`);
  if (names.discovery) await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.discovery)}`);
  if (names.aliases) await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.aliases)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.seen)}`);
}

async function insertSeen(client, tableName, sourceIds) {
  if (!sourceIds.length) return;
  const values = sourceIds.map((_, index) => `($${index + 1})`).join(',');
  await client.query(`
    INSERT INTO semantic_qa.${quoteIdentifier(tableName)} (source_id)
    VALUES ${values} ON CONFLICT (source_id) DO NOTHING
  `, sourceIds);
}

async function getExistingHashes(client, sourceIds) {
  if (!sourceIds.length || !(await recordsTableExists(client))) return new Map();
  const result = await client.query(
    'SELECT source_id, content_hash FROM semantic_qa.records WHERE source_id = ANY($1::text[])',
    [sourceIds],
  );
  return new Map(result.rows.map((row) => [row.source_id, row.content_hash]));
}

async function insertStageRecords(client, tableName, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    params.push(
      row.sourceId,
      row.question,
      row.answer,
      JSON.stringify(row.metadata || {}),
      row.sourceGroup,
      row.sourceOrder == null ? null : JSON.stringify(row.sourceOrder),
      row.contentHash,
      toVectorLiteral(row.embedding),
    );
    return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}::jsonb, $${start + 5}, $${start + 6}::jsonb, $${start + 7}, $${start + 8}::vector)`;
  });
  await client.query(`
    INSERT INTO semantic_qa.${quoteIdentifier(tableName)}
      (source_id, question, answer, metadata, source_group, source_order, content_hash, embedding)
    VALUES ${tuples.join(',')}
    ON CONFLICT (source_id) DO UPDATE SET
      question = EXCLUDED.question, answer = EXCLUDED.answer, metadata = EXCLUDED.metadata,
      source_group = EXCLUDED.source_group, source_order = EXCLUDED.source_order,
      content_hash = EXCLUDED.content_hash, embedding = EXCLUDED.embedding, updated_at = now()
  `, params);
}

async function insertStagePassages(client, tableName, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    params.push(
      row.sourceId,
      row.passageIndex,
      row.answerUnitId,
      row.text,
      row.start,
      row.end,
      row.citationStart,
      row.citationEnd,
      row.citationText,
      row.author,
      row.unitKind,
      row.associatedQuestion || '',
      Boolean(row.contextComplete),
      Boolean(row.storyComplete),
      toVectorLiteral(row.embedding),
    );
    return `(${Array.from({ length: 14 }, (_, index) => `$${start + index + 1}`).join(', ')}, $${start + 15}::vector)`;
  });
  await client.query(`
    INSERT INTO semantic_qa.${quoteIdentifier(tableName)}
      (source_id, passage_index, answer_unit_id, passage_text, start_offset, end_offset,
       citation_start_offset, citation_end_offset, citation_text, author, unit_kind,
       associated_question, context_complete, story_complete, embedding)
    VALUES ${tuples.join(',')}
    ON CONFLICT (source_id, passage_index) DO UPDATE SET
      answer_unit_id = EXCLUDED.answer_unit_id,
      passage_text = EXCLUDED.passage_text,
      start_offset = EXCLUDED.start_offset,
      end_offset = EXCLUDED.end_offset,
      citation_start_offset = EXCLUDED.citation_start_offset,
      citation_end_offset = EXCLUDED.citation_end_offset,
      citation_text = EXCLUDED.citation_text,
      author = EXCLUDED.author,
      unit_kind = EXCLUDED.unit_kind,
      associated_question = EXCLUDED.associated_question,
      context_complete = EXCLUDED.context_complete,
      story_complete = EXCLUDED.story_complete,
      embedding = EXCLUDED.embedding
  `, params);
}

async function insertStageAnswerUnits(client, tableName, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    params.push(row.answerUnitId, row.sourceId, row.unitIndex, row.unitKind, row.author,
      row.associatedQuestion || '', row.language || '', row.start, row.end, row.text,
      row.contentHash, Boolean(row.contextComplete));
    return Array.from({ length: 12 }, (_, index) => `$${start + index + 1}`).join(', ');
  }).map((tuple) => `(${tuple})`);
  await client.query(`
    INSERT INTO semantic_qa.${quoteIdentifier(tableName)}
      (answer_unit_id, source_id, unit_index, unit_kind, author, associated_question,
       language, start_offset, end_offset, unit_text, content_hash, context_complete)
    VALUES ${tuples.join(',')}
  `, params);
}

async function insertStageDiscoveryPassages(client, tableName, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    params.push(row.sourceId, row.discoveryIndex, row.text, toVectorLiteral(row.embedding));
    return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}::vector)`;
  });
  await client.query(`
    INSERT INTO semantic_qa.${quoteIdentifier(tableName)}
      (source_id, discovery_index, discovery_text, embedding)
    VALUES ${tuples.join(',')}
  `, params);
}

async function insertStageAliases(client, tableName, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    params.push(row.aliasId, row.sourceId, row.answerUnitId || null);
    return `($${start + 1}, $${start + 2}, $${start + 3})`;
  });
  await client.query(`
    INSERT INTO semantic_qa.${quoteIdentifier(tableName)} (alias_id, source_id, answer_unit_id)
    VALUES ${tuples.join(',')} ON CONFLICT (alias_id) DO UPDATE SET
      source_id = EXCLUDED.source_id, answer_unit_id = EXCLUDED.answer_unit_id
  `, params);
}

async function createSyncRun(client, job) {
  await client.query(`
    INSERT INTO semantic_qa.sync_runs (id, mode, status)
    VALUES ($1, $2, 'running')
    ON CONFLICT (id) DO UPDATE SET status = 'running', error = NULL, finished_at = NULL
  `, [job.id, job.mode]);
}

async function updateSyncRun(client, job) {
  await client.query(`
    UPDATE semantic_qa.sync_runs
    SET status = $2, processed = $3, changed = $4, total = $5, error = $6,
        finished_at = CASE WHEN $2 = 'running' THEN NULL ELSE now() END
    WHERE id = $1
  `, [job.id, job.status, job.processed, job.changed, job.total, job.error || null]);
}

// JavaScript offsets count UTF-16 code units because citations are ultimately
// reproduced with displayText.slice(start, end). PostgreSQL substring offsets
// count Unicode code points, so a direct SQL equality check reports false
// failures after emoji and other supplementary-plane characters. SQL narrows
// the candidates; JavaScript performs the authoritative verbatim check.
async function countInvalidVerbatimPassages(client) {
  const candidates = await client.query(`
    SELECT p.source_id, p.passage_index,
           p.start_offset AS "start", p.end_offset AS "end",
           p.passage_text AS "passageText",
           p.citation_start_offset AS "citationStart",
           p.citation_end_offset AS "citationEnd",
           p.citation_text AS "citationText",
           r.answer
    FROM semantic_qa.passages p JOIN semantic_qa.records r USING (source_id)
    WHERE p.passage_text <> substring(r.answer FROM p.start_offset + 1 FOR p.end_offset - p.start_offset)
       OR p.citation_text <> substring(r.answer FROM p.citation_start_offset + 1 FOR p.citation_end_offset - p.citation_start_offset)
  `);
  return candidates.rows.reduce((invalid, row) => {
    const answer = String(row.answer || '');
    const passageMatches = answer.slice(Number(row.start), Number(row.end)) === row.passageText;
    const citationMatches = answer.slice(Number(row.citationStart), Number(row.citationEnd)) === row.citationText;
    return invalid + (passageMatches && citationMatches ? 0 : 1);
  }, 0);
}

async function preserveLegacyAliases(client, names, { includeV4Records = false } = {}) {
  if (await relationExists(client, 'source_aliases')) {
    await client.query(`
      INSERT INTO semantic_qa.${quoteIdentifier(names.aliases)} (alias_id, source_id, answer_unit_id)
      SELECT old.alias_id, old.source_id, COALESCE(exact.answer_unit_id, first_unit.answer_unit_id)
      FROM semantic_qa.source_aliases old
      JOIN semantic_qa.${quoteIdentifier(names.stage)} staged ON staged.source_id = old.source_id
      LEFT JOIN semantic_qa.${quoteIdentifier(names.answerUnits)} exact
        ON exact.answer_unit_id = old.answer_unit_id
      LEFT JOIN LATERAL (
        SELECT unit.answer_unit_id
        FROM semantic_qa.${quoteIdentifier(names.answerUnits)} unit
        WHERE unit.source_id = old.source_id
        ORDER BY unit.unit_index
        LIMIT 1
      ) first_unit ON true
      ON CONFLICT (alias_id) DO UPDATE SET
        source_id = EXCLUDED.source_id, answer_unit_id = EXCLUDED.answer_unit_id
    `);
  }
  if (!includeV4Records) return;
  await client.query(`
    INSERT INTO semantic_qa.${quoteIdentifier(names.aliases)} (alias_id, source_id, answer_unit_id)
    SELECT legacy.source_id, staged.source_id, first_unit.answer_unit_id
    FROM semantic_qa.records legacy
    JOIN semantic_qa.${quoteIdentifier(names.stage)} staged
      ON staged.source_id = legacy.source_group
    LEFT JOIN LATERAL (
      SELECT unit.answer_unit_id
      FROM semantic_qa.${quoteIdentifier(names.answerUnits)} unit
      WHERE unit.source_id = staged.source_id
      ORDER BY unit.unit_index
      LIMIT 1
    ) first_unit ON true
    ON CONFLICT (alias_id) DO UPDATE SET
      source_id = EXCLUDED.source_id, answer_unit_id = EXCLUDED.answer_unit_id
  `);
}

async function commitIncremental(client, {
  names, mapping, model, modelDigest = null, dimension, formatVersion, retrievalVersion, ollamaBaseUrl, total,
}) {
  await client.query('BEGIN');
  try {
    await preserveLegacyAliases(client, names);
    await client.query(`
      INSERT INTO semantic_qa.records
        (source_id, question, answer, metadata, source_group, source_order, content_hash, embedding, updated_at)
      SELECT source_id, question, answer, metadata, source_group, source_order, content_hash, embedding, now()
      FROM semantic_qa.${quoteIdentifier(names.stage)}
      ON CONFLICT (source_id) DO UPDATE SET
        question = EXCLUDED.question, answer = EXCLUDED.answer, metadata = EXCLUDED.metadata,
        source_group = EXCLUDED.source_group, source_order = EXCLUDED.source_order,
        content_hash = EXCLUDED.content_hash, embedding = EXCLUDED.embedding, updated_at = now()
    `);
    await client.query(`
      DELETE FROM semantic_qa.records r
      WHERE NOT EXISTS (
        SELECT 1 FROM semantic_qa.${quoteIdentifier(names.seen)} s WHERE s.source_id = r.source_id
      )
    `);
    await client.query(`
      DELETE FROM semantic_qa.passages p
      WHERE p.source_id IN (SELECT source_id FROM semantic_qa.${quoteIdentifier(names.stage)})
         OR NOT EXISTS (SELECT 1 FROM semantic_qa.records r WHERE r.source_id = p.source_id)
    `);
    await client.query(`
      DELETE FROM semantic_qa.answer_units u
      WHERE u.source_id IN (SELECT source_id FROM semantic_qa.${quoteIdentifier(names.stage)})
         OR NOT EXISTS (SELECT 1 FROM semantic_qa.records r WHERE r.source_id = u.source_id)
    `);
    await client.query(`
      DELETE FROM semantic_qa.discovery_passages d
      WHERE d.source_id IN (SELECT source_id FROM semantic_qa.${quoteIdentifier(names.stage)})
         OR NOT EXISTS (SELECT 1 FROM semantic_qa.records r WHERE r.source_id = d.source_id)
    `);
    await client.query(`
      DELETE FROM semantic_qa.source_aliases a
      WHERE a.source_id IN (SELECT source_id FROM semantic_qa.${quoteIdentifier(names.stage)})
         OR NOT EXISTS (SELECT 1 FROM semantic_qa.records r WHERE r.source_id = a.source_id)
    `);
    await client.query(`
      INSERT INTO semantic_qa.passages
        (source_id, passage_index, answer_unit_id, passage_text, start_offset, end_offset,
         citation_start_offset, citation_end_offset, citation_text, author, unit_kind,
         associated_question, context_complete, story_complete, embedding)
      SELECT source_id, passage_index, answer_unit_id, passage_text, start_offset, end_offset,
             citation_start_offset, citation_end_offset, citation_text, author, unit_kind,
             associated_question, context_complete, story_complete, embedding
      FROM semantic_qa.${quoteIdentifier(names.passages)}
    `);
    await client.query(`
      INSERT INTO semantic_qa.answer_units
        (answer_unit_id, source_id, unit_index, unit_kind, author, associated_question,
         language, start_offset, end_offset, unit_text, content_hash, context_complete)
      SELECT answer_unit_id, source_id, unit_index, unit_kind, author, associated_question,
             language, start_offset, end_offset, unit_text, content_hash, context_complete
      FROM semantic_qa.${quoteIdentifier(names.answerUnits)}
    `);
    await client.query(`
      INSERT INTO semantic_qa.discovery_passages (source_id, discovery_index, discovery_text, embedding)
      SELECT source_id, discovery_index, discovery_text, embedding
      FROM semantic_qa.${quoteIdentifier(names.discovery)}
    `);
    await client.query(`
      INSERT INTO semantic_qa.source_aliases (alias_id, source_id, answer_unit_id)
      SELECT alias_id, source_id, answer_unit_id FROM semantic_qa.${quoteIdentifier(names.aliases)}
    `);
    const invalidPassages = await countInvalidVerbatimPassages(client);
    if (invalidPassages) throw new Error(`Verbatim offset validation failed for ${invalidPassages} passages`);
    await client.query(`
      UPDATE semantic_qa.corpus SET source_mapping = $1::jsonb, embedding_model = $2,
        embedding_model_digest = $3, embedding_dimension = $4, embedding_format_version = $5,
        retrieval_schema_version = $6, ollama_base_url = $7, record_count = $8,
        last_synced_at = now(), updated_at = now() WHERE id = 'default'
    `, [JSON.stringify(mapping), model, modelDigest, dimension, formatVersion, retrievalVersion, ollamaBaseUrl, total]);
    await dropSyncStage(client, names);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function commitRebuild(client, {
  names, mapping, model, modelDigest = null, dimension, formatVersion, retrievalVersion, ollamaBaseUrl, total,
}) {
  await client.query('BEGIN');
  try {
    const previous = await client.query("SELECT retrieval_schema_version FROM semantic_qa.corpus WHERE id = 'default'");
    const preserveV4 = previous.rows[0]?.retrieval_schema_version === 'passage-v4';
    await preserveLegacyAliases(client, names, { includeV4Records: preserveV4 });
    if (preserveV4 && !(await relationExists(client, 'records_v4_rollback'))) {
      await client.query('ALTER TABLE semantic_qa.records RENAME TO records_v4_rollback');
      await client.query('ALTER TABLE semantic_qa.passages RENAME TO passages_v4_rollback');
      await client.query('ALTER TABLE semantic_qa.records_v4_rollback RENAME CONSTRAINT records_pkey TO records_v4_rollback_pkey');
      await client.query('ALTER TABLE semantic_qa.passages_v4_rollback RENAME CONSTRAINT passages_pkey TO passages_v4_rollback_pkey');
      await client.query('ALTER INDEX IF EXISTS semantic_qa.semantic_qa_records_embedding_hnsw RENAME TO semantic_qa_records_embedding_hnsw_v4_rollback');
      await client.query('ALTER INDEX IF EXISTS semantic_qa.semantic_qa_records_search_gin RENAME TO semantic_qa_records_search_gin_v4_rollback');
      await client.query('ALTER INDEX IF EXISTS semantic_qa.semantic_qa_records_question_trgm RENAME TO semantic_qa_records_question_trgm_v4_rollback');
      await client.query('ALTER INDEX IF EXISTS semantic_qa.semantic_qa_passages_embedding_hnsw RENAME TO semantic_qa_passages_embedding_hnsw_v4_rollback');
      await client.query('ALTER INDEX IF EXISTS semantic_qa.semantic_qa_passages_search_gin RENAME TO semantic_qa_passages_search_gin_v4_rollback');
      await client.query('ALTER INDEX IF EXISTS semantic_qa.semantic_qa_passages_source_id RENAME TO semantic_qa_passages_source_id_v4_rollback');
      await client.query('ALTER INDEX IF EXISTS semantic_qa.semantic_qa_passages_text_trgm RENAME TO semantic_qa_passages_text_trgm_v4_rollback');
    } else {
      await client.query('DROP TABLE IF EXISTS semantic_qa.records');
      await client.query('DROP TABLE IF EXISTS semantic_qa.passages');
    }
    await client.query('DROP TABLE IF EXISTS semantic_qa.answer_units');
    await client.query('DROP TABLE IF EXISTS semantic_qa.discovery_passages');
    await client.query('DROP TABLE IF EXISTS semantic_qa.source_aliases');
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.stage)} SET LOGGED`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.stage)} RENAME TO records`);
    await client.query(`ALTER TABLE semantic_qa.records RENAME CONSTRAINT ${quoteIdentifier(`${names.stage}_pkey`)} TO records_pkey`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.passages)} SET LOGGED`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.passages)} RENAME TO passages`);
    await client.query(`ALTER TABLE semantic_qa.passages RENAME CONSTRAINT ${quoteIdentifier(`${names.passages}_pkey`)} TO passages_pkey`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.answerUnits)} SET LOGGED`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.answerUnits)} RENAME TO answer_units`);
    await client.query(`ALTER TABLE semantic_qa.answer_units RENAME CONSTRAINT ${quoteIdentifier(`${names.answerUnits}_pkey`)} TO answer_units_pkey`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.discovery)} SET LOGGED`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.discovery)} RENAME TO discovery_passages`);
    await client.query(`ALTER TABLE semantic_qa.discovery_passages RENAME CONSTRAINT ${quoteIdentifier(`${names.discovery}_pkey`)} TO discovery_passages_pkey`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.aliases)} SET LOGGED`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.aliases)} RENAME TO source_aliases`);
    await client.query(`ALTER TABLE semantic_qa.source_aliases RENAME CONSTRAINT ${quoteIdentifier(`${names.aliases}_pkey`)} TO source_aliases_pkey`);
    await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.seen)}`);
    const invalidPassages = await countInvalidVerbatimPassages(client);
    if (invalidPassages) throw new Error(`Verbatim offset validation failed for ${invalidPassages} passages`);
    await createHnswIndex(client);
    await createSearchIndex(client);
    await createPassageIndexes(client);
    await createV5Indexes(client);
    await grantV5ReadAccess(client);
    await client.query(`
      INSERT INTO semantic_qa.corpus
        (id, source_mapping, embedding_model, embedding_model_digest, embedding_dimension,
         embedding_format_version, retrieval_schema_version, ollama_base_url,
         record_count, last_synced_at, updated_at)
      VALUES ('default', $1::jsonb, $2, $3, $4, $5, $6, $7, $8, now(), now())
      ON CONFLICT (id) DO UPDATE SET source_mapping = EXCLUDED.source_mapping,
        embedding_model = EXCLUDED.embedding_model,
        embedding_model_digest = EXCLUDED.embedding_model_digest,
        embedding_dimension = EXCLUDED.embedding_dimension,
        embedding_format_version = EXCLUDED.embedding_format_version,
        retrieval_schema_version = EXCLUDED.retrieval_schema_version,
        ollama_base_url = EXCLUDED.ollama_base_url, record_count = EXCLUDED.record_count,
        last_synced_at = now(), updated_at = now()
    `, [
      JSON.stringify(mapping),
      model,
      modelDigest,
      dimension,
      formatVersion,
      retrievalVersion,
      ollamaBaseUrl,
      total,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

const MIN_CANDIDATE_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 60;
const MAX_CANDIDATE_LIMIT = 200;
const RAW_CANDIDATE_MULTIPLIER = 4;
const MAX_RAW_CANDIDATES = 800;
const MAX_EXPANDABLE_GROUPS = 24;
const MAX_SIBLINGS_PER_GROUP = 100;
const MAX_SIBLING_ROWS = 1200;

function searchLimits(limit) {
  const requested = Number(limit);
  const candidateLimit = Math.max(
    MIN_CANDIDATE_LIMIT,
    Math.min(
      MAX_CANDIDATE_LIMIT,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_CANDIDATE_LIMIT,
    ),
  );
  const rawCandidateLimit = Math.min(MAX_RAW_CANDIDATES, candidateLimit * RAW_CANDIDATE_MULTIPLIER);
  return {
    candidateLimit,
    rawCandidateLimit,
    efSearch: rawCandidateLimit,
    maxExpandableGroups: MAX_EXPANDABLE_GROUPS,
    maxSiblingsPerGroup: MAX_SIBLINGS_PER_GROUP,
    maxSiblingRows: MAX_SIBLING_ROWS,
  };
}

function supportsIterativeHnswScan(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= 8);
}

async function configureHnswSearch(client, efSearch) {
  await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
  const versionResult = await client.query(`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'
  `);
  if (supportsIterativeHnswScan(versionResult.rows[0]?.extversion)) {
    await client.query(`SET LOCAL hnsw.iterative_scan = 'strict_order'`);
  }
}

function groupExpansionPriority(row) {
  const similarity = Number(row.similarity);
  const lexicalScore = Number(row.lexicalScore);
  const dense = Number.isFinite(similarity) ? similarity : -Infinity;
  const lexical = Number.isFinite(lexicalScore) && lexicalScore > 0
    ? 1 - Math.exp(-6 * lexicalScore)
    : -Infinity;
  return Math.max(dense, lexical);
}

function passageMetadataColumns(corpus, alias = 'p') {
  if (corpus?.retrievalSchemaVersion === RETRIEVAL_SCHEMA_VERSION) {
    return `${alias}.answer_unit_id AS "answerUnitId", ${alias}.author, ${alias}.unit_kind AS "unitKind",
            ${alias}.associated_question AS "associatedQuestion",
            ${alias}.citation_start_offset AS "citationStart", ${alias}.citation_end_offset AS "citationEnd",
            ${alias}.citation_text AS "citationText", ${alias}.context_complete AS "contextComplete",
            ${alias}.story_complete AS "storyComplete"`;
  }
  return `NULL::text AS "answerUnitId", 'Swami'::text AS author, 'swami_teaching'::text AS "unitKind",
          ''::text AS "associatedQuestion", ${alias}.start_offset AS "citationStart", ${alias}.end_offset AS "citationEnd",
          ${alias}.passage_text AS "citationText", true AS "contextComplete", true AS "storyComplete"`;
}

function selectExpandableGroups(rows, limit) {
  const groups = new Map();
  for (const row of rows) {
    if (row.sourceGroup == null) continue;
    const chunkCount = Number(row.metadata?.chunk_count);
    if (!Number.isFinite(chunkCount) || chunkCount <= 1) continue;
    const key = String(row.sourceGroup);
    const priority = groupExpansionPriority(row);
    const existing = groups.get(key);
    if (!existing || priority > existing.priority) groups.set(key, { key, priority });
  }
  return [...groups.values()]
    .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((entry) => entry.key);
}

async function searchRecords(client, corpus, vector, queryText, limit, hasLexicalIndex) {
  const vectorLiteral = toVectorLiteral(vector);
  const limits = searchLimits(limit);
  await client.query('BEGIN');
  try {
    await configureHnswSearch(client, limits.efSearch);
    const result = hasLexicalIndex
      ? await client.query(`
        WITH query AS (SELECT websearch_to_tsquery('simple'::regconfig, $2) AS terms),
        dense_raw AS MATERIALIZED (
          SELECT source_id,
                 CASE WHEN source_group IS NOT NULL AND
                   CASE WHEN coalesce(metadata->>'chunk_count', '') ~ '^[0-9]+$'
                     THEN (metadata->>'chunk_count')::numeric > 1 ELSE false END
                 THEN source_group END AS document_group,
                 embedding <=> $1::vector AS distance
          FROM semantic_qa.records
          ORDER BY embedding <=> $1::vector
          LIMIT $4
        ),
        dense_ranked AS MATERIALIZED (
          SELECT source_id, distance,
                 row_number() OVER (
                   PARTITION BY document_group, CASE WHEN document_group IS NULL THEN source_id END
                   ORDER BY distance, source_id
                 ) AS document_rank
          FROM dense_raw
        ),
        dense AS MATERIALIZED (
          SELECT source_id, distance FROM dense_ranked
          WHERE document_rank = 1
          ORDER BY distance, source_id
          LIMIT $3
        ),
        lexical_raw AS MATERIALIZED (
          SELECT r.source_id,
                 CASE WHEN r.source_group IS NOT NULL AND
                   CASE WHEN coalesce(r.metadata->>'chunk_count', '') ~ '^[0-9]+$'
                     THEN (r.metadata->>'chunk_count')::numeric > 1 ELSE false END
                 THEN r.source_group END AS document_group,
                 ts_rank_cd(r.search_vector, q.terms) AS lexical_score
          FROM semantic_qa.records r CROSS JOIN query q
          WHERE q.terms::text <> '' AND r.search_vector @@ q.terms
          ORDER BY ts_rank_cd(r.search_vector, q.terms) DESC, r.source_id
          LIMIT $4
        ),
        lexical_ranked AS MATERIALIZED (
          SELECT source_id, lexical_score,
                 row_number() OVER (
                   PARTITION BY document_group, CASE WHEN document_group IS NULL THEN source_id END
                   ORDER BY lexical_score DESC, source_id
                 ) AS document_rank
          FROM lexical_raw
        ),
        lexical AS MATERIALIZED (
          SELECT source_id, lexical_score FROM lexical_ranked
          WHERE document_rank = 1
          ORDER BY lexical_score DESC, source_id
          LIMIT $3
        ),
        candidates AS (SELECT source_id FROM dense UNION SELECT source_id FROM lexical)
        SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
               r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
               1 - (r.embedding <=> $1::vector) AS similarity,
               ts_rank_cd(r.search_vector, q.terms) AS "lexicalScore"
        FROM candidates c
        JOIN semantic_qa.records r USING (source_id)
        CROSS JOIN query q
      `, [vectorLiteral, queryText, limits.candidateLimit, limits.rawCandidateLimit])
      : await client.query(`
        WITH dense_raw AS MATERIALIZED (
          SELECT source_id,
                 CASE WHEN source_group IS NOT NULL AND
                   CASE WHEN coalesce(metadata->>'chunk_count', '') ~ '^[0-9]+$'
                     THEN (metadata->>'chunk_count')::numeric > 1 ELSE false END
                 THEN source_group END AS document_group,
                 embedding <=> $1::vector AS distance
          FROM semantic_qa.records
          ORDER BY embedding <=> $1::vector
          LIMIT $3
        ),
        dense_ranked AS MATERIALIZED (
          SELECT source_id, distance,
                 row_number() OVER (
                   PARTITION BY document_group, CASE WHEN document_group IS NULL THEN source_id END
                   ORDER BY distance, source_id
                 ) AS document_rank
          FROM dense_raw
        ),
        dense AS MATERIALIZED (
          SELECT source_id, distance FROM dense_ranked
          WHERE document_rank = 1
          ORDER BY distance, source_id
          LIMIT $2
        )
        SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
               r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
               1 - (r.embedding <=> $1::vector) AS similarity,
               0::real AS "lexicalScore"
        FROM dense
        JOIN semantic_qa.records r USING (source_id)
        ORDER BY dense.distance, r.source_id
      `, [vectorLiteral, limits.candidateLimit, limits.rawCandidateLimit]);

    const expandableGroups = selectExpandableGroups(result.rows, limits.maxExpandableGroups);
    let siblingRows = [];
    if (expandableGroups.length) {
      siblingRows = hasLexicalIndex
        ? (await client.query(`
          WITH query AS (SELECT websearch_to_tsquery('simple'::regconfig, $2) AS terms),
          ranked_siblings AS MATERIALIZED (
            SELECT r.source_id, r.question, r.answer, r.metadata, r.source_group, r.source_order, r.embedding,
                   r.search_vector,
                   row_number() OVER (
                     PARTITION BY r.source_group
                     ORDER BY r.source_order NULLS LAST, r.source_id
                   ) AS sibling_rank,
                   array_position($3::text[], r.source_group) AS group_rank
            FROM semantic_qa.records r
            WHERE r.source_group = ANY($3::text[])
          ),
          bounded_siblings AS MATERIALIZED (
            SELECT * FROM ranked_siblings
            WHERE sibling_rank <= $5
            ORDER BY sibling_rank, group_rank
            LIMIT $4
          )
          SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
                 r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
                 1 - (r.embedding <=> $1::vector) AS similarity,
                 ts_rank_cd(r.search_vector, q.terms) AS "lexicalScore"
          FROM bounded_siblings r CROSS JOIN query q
          ORDER BY r.sibling_rank, r.group_rank
        `, [
          vectorLiteral,
          queryText,
          expandableGroups,
          limits.maxSiblingRows,
          limits.maxSiblingsPerGroup,
        ])).rows
        : (await client.query(`
          WITH ranked_siblings AS MATERIALIZED (
            SELECT r.source_id, r.question, r.answer, r.metadata, r.source_group, r.source_order, r.embedding,
                   row_number() OVER (
                     PARTITION BY r.source_group
                     ORDER BY r.source_order NULLS LAST, r.source_id
                   ) AS sibling_rank,
                   array_position($2::text[], r.source_group) AS group_rank
            FROM semantic_qa.records r
            WHERE r.source_group = ANY($2::text[])
          ),
          bounded_siblings AS MATERIALIZED (
            SELECT * FROM ranked_siblings
            WHERE sibling_rank <= $4
            ORDER BY sibling_rank, group_rank
            LIMIT $3
          )
          SELECT source_id AS "sourceId", question, answer, metadata,
                 source_group AS "sourceGroup", source_order AS "sourceOrder",
                 1 - (embedding <=> $1::vector) AS similarity,
                 0::real AS "lexicalScore"
          FROM bounded_siblings
          ORDER BY sibling_rank, group_rank
        `, [
          vectorLiteral,
          expandableGroups,
          limits.maxSiblingRows,
          limits.maxSiblingsPerGroup,
        ])).rows;
    }
    await client.query('COMMIT');
    const unique = new Map([...result.rows, ...siblingRows].map((row) => [row.sourceId, row]));
    return { corpus, rows: [...unique.values()], hybrid: hasLexicalIndex };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function searchIndex(connection, vector, queryText, limit) {
  return withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      await ensureCoreSchema(client);
      const corpus = await getCorpus(client);
      if (!corpus || !(await recordsTableExists(client))) return { corpus, rows: [] };
      const hasLexicalIndex = await searchVectorExists(client);
      return await searchRecords(client, corpus, vector, queryText, limit, hasLexicalIndex);
    } finally {
      client.release();
    }
  });
}

async function searchDiscoveryCandidates(client, vectorLiteral, queryText, limit, discoveryQuestion = queryText) {
  if (!(await relationExists(client, 'discovery_passages'))) return [];
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 60));
  const result = await client.query(`
    WITH query AS MATERIALIZED (SELECT websearch_to_tsquery('simple'::regconfig, $2) AS terms),
    dense AS MATERIALIZED (
      SELECT source_id, max(1 - (embedding <=> $1::vector)) AS discovery_similarity
      FROM (
        SELECT source_id, embedding FROM semantic_qa.discovery_passages
        ORDER BY embedding <=> $1::vector LIMIT $3 * 4
      ) ranked GROUP BY source_id
    ),
    lexical AS MATERIALIZED (
      SELECT d.source_id,
             max(ts_rank_cd(d.search_vector, q.terms)) AS discovery_lexical,
             bool_or(
               lower(regexp_replace(trim(d.discovery_text), '\\s+', ' ', 'g')) =
               lower(regexp_replace(trim($4), '\\s+', ' ', 'g'))
             ) AS discovery_exact
      FROM semantic_qa.discovery_passages d CROSS JOIN query q
      WHERE q.terms::text <> '' AND d.search_vector @@ q.terms
      GROUP BY d.source_id
      ORDER BY discovery_exact DESC, discovery_lexical DESC
      LIMIT $3 * 4
    ),
    sources AS MATERIALIZED (
      SELECT coalesce(d.source_id, l.source_id) AS source_id,
             coalesce(d.discovery_similarity, 0) AS discovery_similarity,
             coalesce(l.discovery_lexical, 0) AS discovery_lexical,
             coalesce(l.discovery_exact, false) AS discovery_exact
      FROM dense d FULL JOIN lexical l USING (source_id)
      ORDER BY coalesce(l.discovery_exact, false) DESC,
               greatest(coalesce(d.discovery_similarity, 0), 1 - exp(-6 * coalesce(l.discovery_lexical, 0))) DESC
      LIMIT $3
    )
    SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
           r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
           p.passage_index AS "passageIndex", p.passage_text AS "passageText",
           p.start_offset AS "passageStart", p.end_offset AS "passageEnd",
           p.answer_unit_id AS "answerUnitId", p.author, p.unit_kind AS "unitKind",
           p.associated_question AS "associatedQuestion",
           p.citation_start_offset AS "citationStart", p.citation_end_offset AS "citationEnd",
           p.citation_text AS "citationText", p.context_complete AS "contextComplete",
           p.story_complete AS "storyComplete",
           1 - (p.embedding <=> $1::vector) AS similarity,
           ts_rank_cd(p.search_vector, q.terms) AS "lexicalScore",
           s.discovery_similarity AS "discoverySimilarity",
           s.discovery_lexical AS "discoveryLexicalScore",
           s.discovery_exact AS "discoveryExact",
           ARRAY['discovery']::text[] AS "matchChannels"
    FROM sources s
    JOIN semantic_qa.records r USING (source_id)
    JOIN LATERAL (
      SELECT * FROM semantic_qa.passages candidate
      WHERE candidate.source_id = s.source_id
      ORDER BY candidate.embedding <=> $1::vector, candidate.passage_index
      LIMIT 3
    ) p ON true
    CROSS JOIN query q
  `, [vectorLiteral, queryText, boundedLimit, discoveryQuestion]);
  return result.rows;
}

async function searchPassages(client, corpus, vector, queryText, limit, discoveryQuestion = queryText) {
  const vectorLiteral = toVectorLiteral(vector);
  const limits = searchLimits(limit);
  await client.query('BEGIN');
  try {
    await configureHnswSearch(client, limits.efSearch);
    const result = await client.query(`
      WITH query AS (SELECT websearch_to_tsquery('simple'::regconfig, $2) AS terms),
      dense_raw AS MATERIALIZED (
        SELECT source_id, passage_index, embedding <=> $1::vector AS distance
        FROM semantic_qa.passages
        ORDER BY embedding <=> $1::vector
        LIMIT $4
      ),
      dense_ranked AS MATERIALIZED (
        SELECT source_id, passage_index, distance,
               row_number() OVER (PARTITION BY source_id ORDER BY distance, passage_index) AS source_rank
        FROM dense_raw
      ),
      dense AS MATERIALIZED (
        SELECT source_id, passage_index, distance
        FROM dense_ranked
        WHERE source_rank <= 3
        ORDER BY distance, source_id, passage_index
        LIMIT $3
      ),
      lexical_raw AS MATERIALIZED (
        SELECT p.source_id, p.passage_index,
               ts_rank_cd(p.search_vector, q.terms) AS lexical_score
        FROM semantic_qa.passages p CROSS JOIN query q
        WHERE q.terms::text <> '' AND p.search_vector @@ q.terms
        ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC, p.source_id, p.passage_index
        LIMIT $4
      ),
      lexical_ranked AS MATERIALIZED (
        SELECT source_id, passage_index, lexical_score,
               row_number() OVER (
                 PARTITION BY source_id ORDER BY lexical_score DESC, passage_index
               ) AS source_rank
        FROM lexical_raw
      ),
      lexical AS MATERIALIZED (
        SELECT source_id, passage_index, lexical_score
        FROM lexical_ranked
        WHERE source_rank <= 3
        ORDER BY lexical_score DESC, source_id, passage_index
        LIMIT $3
      ),
      candidates AS (
        SELECT source_id, passage_index FROM dense
        UNION
        SELECT source_id, passage_index FROM lexical
      )
      SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
             r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
             p.passage_index AS "passageIndex", p.passage_text AS "passageText",
             p.start_offset AS "passageStart", p.end_offset AS "passageEnd",
             ${passageMetadataColumns(corpus, 'p')},
             1 - (p.embedding <=> $1::vector) AS similarity,
             ts_rank_cd(p.search_vector, q.terms) AS "lexicalScore"
      FROM candidates c
      JOIN semantic_qa.passages p USING (source_id, passage_index)
      JOIN semantic_qa.records r USING (source_id)
      CROSS JOIN query q
    `, [vectorLiteral, queryText, limits.candidateLimit, limits.rawCandidateLimit]);
    const discoveryRows = corpus.retrievalSchemaVersion === RETRIEVAL_SCHEMA_VERSION
      ? await searchDiscoveryCandidates(client, vectorLiteral, queryText, limits.candidateLimit, discoveryQuestion)
      : [];
    await client.query('COMMIT');
    const rows = new Map();
    for (const row of [...result.rows, ...discoveryRows]) {
      const key = `${row.sourceId}:${row.passageIndex}`;
      const existing = rows.get(key);
      rows.set(key, existing ? {
        ...existing,
        discoverySimilarity: row.discoverySimilarity ?? existing.discoverySimilarity,
        discoveryLexicalScore: row.discoveryLexicalScore ?? existing.discoveryLexicalScore,
        discoveryExact: row.discoveryExact ?? existing.discoveryExact,
        matchChannels: [...new Set([...(existing.matchChannels || []), ...(row.matchChannels || [])])],
      } : row);
    }
    return { corpus, rows: [...rows.values()], hybrid: true, unit: 'answer_passage' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function searchPassageIndex(connection, vector, queryText, limit, discoveryQuestion = queryText) {
  return withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      await ensureCoreSchema(client);
      const corpus = await getCorpus(client);
      if (!corpus || !(await recordsTableExists(client)) || !(await passagesTableExists(client))) {
        return { corpus, rows: [], hybrid: true, unit: 'answer_passage' };
      }
      return await searchPassages(client, corpus, vector, queryText, limit, discoveryQuestion);
    } finally {
      client.release();
    }
  });
}

async function searchAllPassages(client, corpus, vector, queryText, minimumSimilarity = 0.25, maximumRows = 180) {
  const vectorLiteral = toVectorLiteral(vector);
  const similarityFloor = Math.max(-1, Math.min(1, Number(minimumSimilarity) || 0.25));
  const resultLimit = Math.max(1, Math.min(MAX_RAW_CANDIDATES, Math.trunc(Number(maximumRows)) || 180));
  const result = await client.query(`
    WITH query AS MATERIALIZED (
      SELECT websearch_to_tsquery('simple'::regconfig, $2) AS terms
    ),
    corpus_stats AS MATERIALIZED (
      SELECT count(*)::integer AS passage_count FROM semantic_qa.passages
    ),
    all_scored AS MATERIALIZED (
      (
        SELECT p.source_id, p.passage_index, p.passage_text, p.start_offset, p.end_offset,
               1 - (p.embedding <=> $1::vector) AS similarity,
               0.0::float8 AS lexical_score
        FROM semantic_qa.passages p
        ORDER BY p.embedding <=> $1::vector
        LIMIT 300
      )
      UNION ALL
      (
        SELECT p.source_id, p.passage_index, p.passage_text, p.start_offset, p.end_offset,
               1 - (p.embedding <=> $1::vector) AS similarity,
               ts_rank_cd(p.search_vector, q.terms) AS lexical_score
        FROM semantic_qa.passages p CROSS JOIN query q
        WHERE q.terms::text <> '' AND p.search_vector @@ q.terms
        ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC
        LIMIT 100
      )
    ),
    eligible AS MATERIALIZED (
      SELECT *, row_number() OVER (
        PARTITION BY source_id
        ORDER BY similarity DESC, lexical_score DESC, passage_index
      ) AS source_rank
      FROM all_scored
      WHERE similarity >= $3 OR lexical_score > 0
    )
    SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
           r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
           e.passage_index AS "passageIndex", e.passage_text AS "passageText",
           e.start_offset AS "passageStart", e.end_offset AS "passageEnd",
           ${passageMetadataColumns(corpus, 'p')},
           e.similarity, e.lexical_score AS "lexicalScore",
           stats.passage_count AS "scannedPassages"
    FROM eligible e
    JOIN semantic_qa.passages p USING (source_id, passage_index)
    JOIN semantic_qa.records r USING (source_id)
    CROSS JOIN corpus_stats stats
    WHERE e.source_rank <= 3
    ORDER BY e.similarity DESC, e.lexical_score DESC, r.source_id, e.passage_index
    LIMIT $4
  `, [vectorLiteral, queryText, similarityFloor, resultLimit]);
  const discoveryRows = corpus.retrievalSchemaVersion === RETRIEVAL_SCHEMA_VERSION
    ? await searchDiscoveryCandidates(client, vectorLiteral, queryText, Math.min(resultLimit, 120))
    : [];
  const fusedRows = new Map();
  for (const row of [...result.rows, ...discoveryRows]) {
    const key = `${row.sourceId}:${row.passageIndex}`;
    const existing = fusedRows.get(key);
    fusedRows.set(key, existing ? {
      ...existing,
      discoverySimilarity: row.discoverySimilarity ?? existing.discoverySimilarity,
      discoveryLexicalScore: row.discoveryLexicalScore ?? existing.discoveryLexicalScore,
      matchChannels: [...new Set([...(existing.matchChannels || []), ...(row.matchChannels || [])])],
    } : row);
  }
  const scannedPassages = Number(result.rows[0]?.scannedPassages || 0);
  return {
    corpus,
    rows: [...fusedRows.values()].slice(0, resultLimit).map(({ scannedPassages: _scannedPassages, ...row }) => row),
    hybrid: true,
    exhaustive: true,
    scannedPassages,
    unit: 'answer_passage',
  };
}

async function searchAllPassageIndex(connection, vector, queryText, minimumSimilarity, maximumRows) {
  return withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      await ensureCoreSchema(client);
      const corpus = await getCorpus(client);
      if (!corpus || !(await recordsTableExists(client)) || !(await passagesTableExists(client))) {
        return { corpus, rows: [], hybrid: true, exhaustive: true, scannedPassages: 0, unit: 'answer_passage' };
      }
      return await searchAllPassages(client, corpus, vector, queryText, minimumSimilarity, maximumRows);
    } finally {
      client.release();
    }
  });
}

async function searchTextRecords(client, corpus, queryText, limit) {
  const query = String(queryText || '').trim();
  if (!query) return { corpus, rows: [], hybrid: true, unit: 'text_passage' };
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const hasDiscovery = corpus.retrievalSchemaVersion === RETRIEVAL_SCHEMA_VERSION && await relationExists(client, 'discovery_passages');
  const discoveryPrimaryCtes = hasDiscovery ? `
      exact_discovery AS MATERIALIZED (
        SELECT d.source_id, min(p.passage_index) AS passage_index,
               row_number() OVER (ORDER BY max(matched.phrase_length) DESC, d.source_id) AS rank,
               'exact discovery'::text AS channel, 3.0::float8 AS weight
        FROM semantic_qa.discovery_passages d CROSS JOIN input q
        CROSS JOIN LATERAL (
          SELECT max(length(phrase)) AS phrase_length FROM unnest(q.phrases) AS phrase
          WHERE position(lower(phrase) in lower(d.discovery_text)) > 0
        ) matched
        JOIN semantic_qa.passages p USING (source_id)
        WHERE matched.phrase_length IS NOT NULL
        GROUP BY d.source_id
        ORDER BY max(matched.phrase_length) DESC, d.source_id
        LIMIT $2 * 4
      ),
      full_text_discovery AS MATERIALIZED (
        SELECT d.source_id, min(p.passage_index) AS passage_index,
               row_number() OVER (ORDER BY max(ts_rank_cd(d.search_vector, q.terms)) DESC, d.source_id) AS rank,
               'discovery full text'::text AS channel, 1.9::float8 AS weight
        FROM semantic_qa.discovery_passages d CROSS JOIN input q
        JOIN semantic_qa.passages p USING (source_id)
        WHERE q.terms::text <> '' AND d.search_vector @@ q.terms
        GROUP BY d.source_id
        ORDER BY max(ts_rank_cd(d.search_vector, q.terms)) DESC, d.source_id
        LIMIT $2 * 5
      ),` : `
      exact_discovery AS MATERIALIZED (
        SELECT NULL::text AS source_id, NULL::integer AS passage_index, NULL::bigint AS rank,
               NULL::text AS channel, NULL::float8 AS weight WHERE false
      ),
      full_text_discovery AS MATERIALIZED (
        SELECT NULL::text AS source_id, NULL::integer AS passage_index, NULL::bigint AS rank,
               NULL::text AS channel, NULL::float8 AS weight WHERE false
      ),`;
  const discoveryFuzzyCte = hasDiscovery ? `
      fuzzy_discovery AS MATERIALIZED (
        SELECT d.source_id, min(p.passage_index) AS passage_index,
               row_number() OVER (ORDER BY max(word_similarity(q.text, d.discovery_text)) DESC, d.source_id) AS rank,
               'fuzzy discovery'::text AS channel, 1.1::float8 AS weight
        FROM semantic_qa.discovery_passages d CROSS JOIN input q CROSS JOIN primary_source_count c
        JOIN semantic_qa.passages p USING (source_id)
        WHERE c.count < $2 AND q.text <% d.discovery_text
        GROUP BY d.source_id
        ORDER BY max(word_similarity(q.text, d.discovery_text)) DESC, d.source_id
        LIMIT $2 * 4
      ),` : `
      fuzzy_discovery AS MATERIALIZED (
        SELECT NULL::text AS source_id, NULL::integer AS passage_index, NULL::bigint AS rank,
               NULL::text AS channel, NULL::float8 AS weight WHERE false
      ),`;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = 0.22`);
    const result = await client.query(`
      WITH input AS MATERIALIZED (
        SELECT $1::text AS text, websearch_to_tsquery('simple'::regconfig, $3) AS terms, $4::text[] AS phrases
      ),
      exact_passage AS MATERIALIZED (
        SELECT p.source_id, p.passage_index,
               row_number() OVER (ORDER BY matched.phrase_length DESC, length(p.passage_text), p.source_id, p.passage_index) AS rank,
               'exact passage'::text AS channel, 4.0::float8 AS weight
        FROM semantic_qa.passages p CROSS JOIN input q
        CROSS JOIN LATERAL (
          SELECT max(length(phrase)) AS phrase_length
          FROM unnest(q.phrases) AS phrase
          WHERE position(lower(phrase) in lower(p.passage_text)) > 0
        ) matched
        WHERE matched.phrase_length IS NOT NULL
        ORDER BY matched.phrase_length DESC, length(p.passage_text), p.source_id, p.passage_index
        LIMIT $2 * 4
      ),
      full_text_passage AS MATERIALIZED (
        SELECT p.source_id, p.passage_index,
               row_number() OVER (ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC, p.source_id, p.passage_index) AS rank,
               'full text'::text AS channel, 2.2::float8 AS weight
        FROM semantic_qa.passages p CROSS JOIN input q
        WHERE q.terms::text <> '' AND p.search_vector @@ q.terms
        ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC, p.source_id, p.passage_index
        LIMIT $2 * 6
      ),
      exact_title AS MATERIALIZED (
        SELECT r.source_id, coalesce(min(p.passage_index), 0) AS passage_index,
               row_number() OVER (ORDER BY max(matched.phrase_length) DESC, length(r.question), r.source_id) AS rank,
               'exact title'::text AS channel, 3.2::float8 AS weight
        FROM semantic_qa.records r
        CROSS JOIN input q
        CROSS JOIN LATERAL (
          SELECT max(length(phrase)) AS phrase_length
          FROM unnest(q.phrases) AS phrase
          WHERE position(lower(phrase) in lower(r.question)) > 0
        ) matched
        LEFT JOIN semantic_qa.passages p USING (source_id)
        WHERE matched.phrase_length IS NOT NULL
        GROUP BY r.source_id, r.question
        ORDER BY max(matched.phrase_length) DESC, length(r.question), r.source_id
        LIMIT $2 * 4
      ),
      full_text_title AS MATERIALIZED (
        SELECT r.source_id, coalesce(min(p.passage_index), 0) AS passage_index,
               row_number() OVER (ORDER BY ts_rank_cd(to_tsvector('simple'::regconfig, r.question), q.terms) DESC, r.source_id) AS rank,
               'title full text'::text AS channel, 1.8::float8 AS weight
        FROM semantic_qa.records r
        CROSS JOIN input q
        LEFT JOIN semantic_qa.passages p USING (source_id)
        WHERE q.terms::text <> '' AND to_tsvector('simple'::regconfig, r.question) @@ q.terms
        GROUP BY r.source_id, r.question, q.terms
        ORDER BY ts_rank_cd(to_tsvector('simple'::regconfig, r.question), q.terms) DESC, r.source_id
        LIMIT $2 * 5
      ),
      ${discoveryPrimaryCtes}
      primary_candidates AS MATERIALIZED (
        SELECT * FROM exact_passage UNION ALL SELECT * FROM full_text_passage
        UNION ALL SELECT * FROM exact_title UNION ALL SELECT * FROM full_text_title
        UNION ALL SELECT * FROM exact_discovery UNION ALL SELECT * FROM full_text_discovery
      ),
      primary_source_count AS MATERIALIZED (
        SELECT count(DISTINCT source_id) AS count FROM primary_candidates
      ),
      fuzzy_passage AS MATERIALIZED (
        SELECT p.source_id, p.passage_index,
               row_number() OVER (ORDER BY word_similarity(q.text, p.passage_text) DESC, p.source_id, p.passage_index) AS rank,
               'fuzzy passage'::text AS channel, 1.2::float8 AS weight
        FROM semantic_qa.passages p CROSS JOIN input q CROSS JOIN primary_source_count c
        WHERE c.count < $2 AND q.text <% p.passage_text
        ORDER BY word_similarity(q.text, p.passage_text) DESC, p.source_id, p.passage_index
        LIMIT $2 * 4
      ),
      fuzzy_title AS MATERIALIZED (
        SELECT r.source_id, coalesce(min(p.passage_index), 0) AS passage_index,
               row_number() OVER (ORDER BY word_similarity(q.text, r.question) DESC, r.source_id) AS rank,
               'fuzzy title'::text AS channel, 1.0::float8 AS weight
        FROM semantic_qa.records r
        CROSS JOIN input q CROSS JOIN primary_source_count c
        LEFT JOIN semantic_qa.passages p USING (source_id)
        WHERE c.count < $2 AND q.text <% r.question
        GROUP BY r.source_id, r.question, q.text
        ORDER BY word_similarity(q.text, r.question) DESC, r.source_id
        LIMIT $2 * 4
      ),
      ${discoveryFuzzyCte}
      candidates AS MATERIALIZED (
        SELECT * FROM primary_candidates UNION ALL SELECT * FROM fuzzy_passage
        UNION ALL SELECT * FROM fuzzy_title UNION ALL SELECT * FROM fuzzy_discovery
      ),
      fused AS MATERIALIZED (
        SELECT source_id, passage_index,
               sum(weight / (60.0 + rank)) AS rrf_score,
               array_agg(DISTINCT channel) AS channels
        FROM candidates
        GROUP BY source_id, passage_index
      ),
      ranked AS MATERIALIZED (
        SELECT *, row_number() OVER (PARTITION BY source_id ORDER BY rrf_score DESC, passage_index) AS source_rank
        FROM fused
      )
      SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
             r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
             p.passage_index AS "passageIndex", p.passage_text AS "passageText",
             p.start_offset AS "passageStart", p.end_offset AS "passageEnd",
             ${passageMetadataColumns(corpus, 'p')},
             least(1, ranked.rrf_score / 0.10) AS "searchScore",
             ranked.channels AS "matchChannels",
             ts_rank_cd(p.search_vector, q.terms) AS "lexicalScore",
             word_similarity(q.text, p.passage_text) AS "trigramSimilarity"
      FROM ranked
      JOIN semantic_qa.records r USING (source_id)
      JOIN semantic_qa.passages p USING (source_id, passage_index)
      CROSS JOIN input q
      WHERE ranked.source_rank <= 3
      ORDER BY ranked.rrf_score DESC, r.source_id, p.passage_index
      LIMIT $2 * 3
    `, [query, boundedLimit, buildLexicalQuery(query), buildTextPhraseQueries(query)]);
    await client.query('COMMIT');
    return { corpus, rows: result.rows, hybrid: true, unit: 'text_passage' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function searchTextIndex(connection, queryText, limit) {
  return withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      await ensureCoreSchema(client);
      const corpus = await getCorpus(client);
      if (!corpus || !(await recordsTableExists(client)) || !(await passagesTableExists(client))) {
        return { corpus, rows: [], hybrid: true, unit: 'text_passage' };
      }
      return await searchTextRecords(client, corpus, queryText, limit);
    } finally {
      client.release();
    }
  });
}

async function listDocuments(connection, { query = '', page = 1, pageSize = 50 } = {}) {
  return withPool(connection, async (pool) => {
    await ensureCoreSchema(pool);
    const normalizedQuery = String(query || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const boundedPage = Math.max(1, Number(page) || 1);
    const boundedSize = Math.max(10, Math.min(100, Number(pageSize) || 50));
    const offset = (boundedPage - 1) * boundedSize;
    const browseSql = `
      WITH ranked_records AS MATERIALIZED (
        SELECT coalesce(r.source_group, r.source_id) AS source_group,
               r.source_id, r.question, r.answer, r.metadata,
               row_number() OVER (
                 PARTITION BY coalesce(r.source_group, r.source_id)
                 ORDER BY r.source_id
               ) AS source_rank,
               count(*) OVER (
                 PARTITION BY coalesce(r.source_group, r.source_id)
               )::integer AS chunk_count
        FROM semantic_qa.records r
        WHERE r.metadata->>'source_type' = 'discourse'
      )
      SELECT rr.source_group AS "sourceGroup", rr.question AS title,
             rr.metadata->>'language' AS language,
             rr.metadata->>'record_date' AS "recordDate",
             rr.chunk_count AS "chunkCount", rr.source_id AS "firstSourceId",
             rr.source_id AS "previewSourceId", 'Discourse'::text AS "matchKind",
             btrim(regexp_replace(left(rr.answer, 720), '[[:space:]]+', ' ', 'g')) AS "answerPreview",
             count(*) OVER ()::integer AS total
      FROM ranked_records rr
      WHERE rr.source_rank = 1
      ORDER BY rr.metadata->>'record_date' DESC NULLS LAST, rr.question, rr.source_group
      LIMIT $1 OFFSET $2
    `;
    const searchSql = `
      WITH input AS MATERIALIZED (
        SELECT $1::text AS text, websearch_to_tsquery('simple'::regconfig, $4) AS terms,
               set_config('pg_trgm.word_similarity_threshold', '0.22', true) AS fuzzy_threshold
      ),
      discourses AS MATERIALIZED (
        SELECT r.*, coalesce(r.source_group, r.source_id) AS document_group
        FROM semantic_qa.records r
        WHERE r.metadata->>'source_type' = 'discourse'
      ),
      documents AS MATERIALIZED (
        SELECT d.document_group, (array_agg(d.question ORDER BY d.source_id))[1] AS title,
               min(d.metadata->>'language') AS language,
               min(d.metadata->>'record_date') AS record_date,
               count(*)::integer AS chunk_count, min(d.source_id) AS first_source_id
        FROM discourses d GROUP BY d.document_group
      ),
      exact_answers AS MATERIALIZED (
        SELECT d.document_group, d.source_id, p.passage_index,
               120::float8 AS match_score, 'Exact answer match'::text AS match_kind
        FROM semantic_qa.passages p
        JOIN discourses d USING (source_id)
        CROSS JOIN input q
        WHERE p.passage_text ILIKE '%' || q.text || '%'
      ),
      full_text_answers AS MATERIALIZED (
        SELECT d.document_group, d.source_id, p.passage_index,
               (55 + ts_rank_cd(p.search_vector, q.terms) * 30)::float8 AS match_score,
               'Answer content match'::text AS match_kind
        FROM semantic_qa.passages p
        JOIN discourses d USING (source_id)
        CROSS JOIN input q
        WHERE p.search_vector @@ q.terms
      ),
      exact_questions AS MATERIALIZED (
        SELECT DISTINCT ON (d.document_group)
               d.document_group, d.source_id, p.passage_index,
               100::float8 AS match_score, 'Exact question match'::text AS match_kind
        FROM discourses d
        JOIN LATERAL (
          SELECT passage_index FROM semantic_qa.passages
          WHERE source_id = d.source_id ORDER BY passage_index LIMIT 1
        ) p ON true
        CROSS JOIN input q
        WHERE d.question ILIKE '%' || q.text || '%'
        ORDER BY d.document_group, d.source_id, p.passage_index
      ),
      full_text_questions AS MATERIALIZED (
        SELECT DISTINCT ON (d.document_group)
               d.document_group, d.source_id, p.passage_index,
               (45 + ts_rank_cd(to_tsvector('simple'::regconfig, d.question), q.terms) * 35)::float8 AS match_score,
               'Question match'::text AS match_kind
        FROM discourses d
        JOIN LATERAL (
          SELECT passage_index FROM semantic_qa.passages
          WHERE source_id = d.source_id ORDER BY passage_index LIMIT 1
        ) p ON true
        CROSS JOIN input q
        WHERE to_tsvector('simple'::regconfig, d.question) @@ q.terms
        ORDER BY d.document_group, d.source_id, p.passage_index
      ),
      primary_candidates AS MATERIALIZED (
        SELECT * FROM exact_answers UNION ALL SELECT * FROM full_text_answers
        UNION ALL SELECT * FROM exact_questions UNION ALL SELECT * FROM full_text_questions
      ),
      primary_document_count AS MATERIALIZED (
        SELECT count(DISTINCT document_group) AS count FROM primary_candidates
      ),
      fuzzy_answers AS MATERIALIZED (
        SELECT d.document_group, d.source_id, p.passage_index,
               (20 + word_similarity(q.text, p.passage_text) * 8)::float8 AS match_score,
               'Closest answer text'::text AS match_kind
        FROM semantic_qa.passages p
        JOIN discourses d USING (source_id)
        CROSS JOIN input q CROSS JOIN primary_document_count c
        WHERE c.count < $2 AND q.text <% p.passage_text
      ),
      fuzzy_questions AS MATERIALIZED (
        SELECT DISTINCT ON (d.document_group)
               d.document_group, d.source_id, p.passage_index,
               (15 + word_similarity(q.text, d.question) * 10)::float8 AS match_score,
               'Closest question text'::text AS match_kind
        FROM discourses d
        JOIN LATERAL (
          SELECT passage_index FROM semantic_qa.passages
          WHERE source_id = d.source_id ORDER BY passage_index LIMIT 1
        ) p ON true
        CROSS JOIN input q CROSS JOIN primary_document_count c
        WHERE c.count < $2 AND q.text <% d.question
        ORDER BY d.document_group, match_score DESC, d.source_id, p.passage_index
      ),
      all_candidates AS MATERIALIZED (
        SELECT * FROM primary_candidates UNION ALL SELECT * FROM fuzzy_answers
        UNION ALL SELECT * FROM fuzzy_questions
      ),
      deduplicated_candidates AS MATERIALIZED (
        SELECT DISTINCT ON (document_group, source_id, passage_index)
               document_group, source_id, passage_index, match_score, match_kind
        FROM all_candidates
        ORDER BY document_group, source_id, passage_index, match_score DESC
      ),
      ranked_matches AS MATERIALIZED (
        SELECT c.*,
               row_number() OVER (
                 PARTITION BY c.document_group
                 ORDER BY c.match_score DESC, c.source_id, c.passage_index
               ) AS match_rank
        FROM deduplicated_candidates c
      )
      SELECT d.document_group AS "sourceGroup", d.title, d.language, d.record_date AS "recordDate",
             d.chunk_count AS "chunkCount", d.first_source_id AS "firstSourceId",
             rm.source_id AS "previewSourceId", rm.match_kind AS "matchKind",
             rm.match_score AS "matchScore",
             btrim(regexp_replace(
               CASE
                 WHEN p.search_vector @@ q.terms
                   THEN replace(replace(ts_headline(
                     'simple'::regconfig,
                     p.passage_text,
                     q.terms,
                     'MaxWords=72, MinWords=28, ShortWord=2, HighlightAll=false, MaxFragments=2'
                   ), '<b>', ''), '</b>', '')
                 ELSE left(p.passage_text, 720)
               END,
               '[[:space:]]+', ' ', 'g'
             )) AS "answerPreview",
             CASE WHEN position(lower(q.text) in lower(p.passage_text)) > 0
                  THEN p.start_offset + position(lower(q.text) in lower(p.passage_text)) - 1 END AS "highlightStart",
             CASE WHEN position(lower(q.text) in lower(p.passage_text)) > 0
                  THEN p.start_offset + position(lower(q.text) in lower(p.passage_text)) - 1 + length(q.text) END AS "highlightEnd",
             count(*) OVER ()::integer AS total
      FROM documents d
      JOIN ranked_matches rm ON rm.document_group = d.document_group AND rm.match_rank = 1
      JOIN semantic_qa.passages p USING (source_id, passage_index)
      CROSS JOIN input q
      ORDER BY rm.match_score DESC, d.title, d.document_group
      LIMIT $2 OFFSET $3
    `;
    const result = normalizedQuery
      ? await pool.query(searchSql, [normalizedQuery, boundedSize, offset, buildLexicalQuery(normalizedQuery)])
      : await pool.query(browseSql, [boundedSize, offset]);
    return {
      page: boundedPage,
      pageSize: boundedSize,
      total: Number(result.rows[0]?.total || 0),
      documents: result.rows.map(({ total: _total, ...row }) => row),
    };
  });
}

async function getDocumentRecords(connection, reference) {
  return withPool(connection, async (pool) => {
    const hasAliases = await relationExists(pool, 'source_aliases');
    const result = await pool.query(`
      WITH requested AS (
        SELECT $1::text AS reference
      ), resolved AS (
        SELECT coalesce(a.source_id, requested.reference) AS source_id
        FROM requested
        ${hasAliases ? 'LEFT JOIN semantic_qa.source_aliases a ON a.alias_id = requested.reference' : ''}
      ), selected AS (
        SELECT coalesce(records.source_group, records.source_id) AS source_group
        FROM semantic_qa.records CROSS JOIN resolved
        WHERE records.source_id = resolved.source_id OR records.source_group = resolved.source_id
        ORDER BY CASE WHEN records.source_id = resolved.source_id THEN 0 ELSE 1 END
        LIMIT 1
      )
      SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
             r.source_group AS "sourceGroup", r.source_order AS "sourceOrder"
      FROM semantic_qa.records r JOIN selected s ON coalesce(r.source_group, r.source_id) = s.source_group
      ORDER BY CASE WHEN coalesce(r.metadata->>'chunk_index', '') ~ '^[0-9]+$'
                    THEN (r.metadata->>'chunk_index')::integer ELSE 2147483647 END,
               r.source_id
    `, [String(reference || '')]);
    return result.rows;
  });
}

async function getAnswerUnits(connection, references) {
  const requested = [...new Set((Array.isArray(references) ? references : [references]).map(String).filter(Boolean))];
  if (!requested.length) return [];
  return withPool(connection, async (pool) => {
    if (!(await relationExists(pool, 'answer_units'))) return [];
    const result = await pool.query(`
      WITH requested(reference) AS (SELECT unnest($1::text[])),
      resolved AS (
        SELECT requested.reference, coalesce(a.source_id, requested.reference) AS source_id,
               a.answer_unit_id
        FROM requested LEFT JOIN semantic_qa.source_aliases a ON a.alias_id = requested.reference
      )
      SELECT resolved.reference AS "requestedReference", u.answer_unit_id AS "answerUnitId",
             u.source_id AS "sourceId", r.question AS title, r.metadata,
             u.unit_index AS "unitIndex", u.unit_kind AS "unitKind", u.author,
             u.associated_question AS "associatedQuestion", u.language,
             u.start_offset AS start, u.end_offset AS "end", u.unit_text AS text,
             r.answer AS "displayText",
             u.content_hash AS "contentHash", u.context_complete AS "contextComplete"
      FROM resolved
      JOIN semantic_qa.answer_units u ON u.source_id = resolved.source_id
        AND (resolved.answer_unit_id IS NULL OR u.answer_unit_id = resolved.answer_unit_id)
      JOIN semantic_qa.records r ON r.source_id = u.source_id
      ORDER BY array_position($1::text[], resolved.reference), u.unit_index
    `, [requested]);
    return result.rows;
  });
}

module.exports = {
  connectionToPoolConfig,
  buildTextPhraseQueries,
  createPool,
  withPool,
  testPostgresConnection,
  discoverSourceCatalog,
  validateMapping,
  openSourceSnapshot,
  ensureCoreSchema,
  recordsTableExists,
  passagesTableExists,
  initializeIndex,
  testIndexConnection,
  getIndexStatus,
  getCorpus,
  createSyncStage,
  dropSyncStage,
  insertSeen,
  getExistingHashes,
  insertStageRecords,
  insertStagePassages,
  insertStageAnswerUnits,
  insertStageDiscoveryPassages,
  insertStageAliases,
  createSyncRun,
  updateSyncRun,
  preserveLegacyAliases,
  commitIncremental,
  commitRebuild,
  searchRecords,
  searchIndex,
  searchPassages,
  searchPassageIndex,
  searchAllPassages,
  searchAllPassageIndex,
  searchTextRecords,
  searchTextIndex,
  listDocuments,
  getDocumentRecords,
  getAnswerUnits,
};
