const { requireToolDep } = require('../requireToolDep');
const {
  quoteIdentifier,
  assertIdentifier,
  toVectorLiteral,
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
  await client.query('CREATE SCHEMA IF NOT EXISTS semantic_qa');
  await client.query(`
    CREATE TABLE IF NOT EXISTS semantic_qa.corpus (
      id text PRIMARY KEY,
      source_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
      embedding_model text NOT NULL,
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
}

async function recordsTableExists(client) {
  const result = await client.query(`SELECT to_regclass('semantic_qa.records') IS NOT NULL AS exists`);
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
        setweight(to_tsvector('simple'::regconfig, coalesce(metadata->>'source_context', '')), 'B') ||
        setweight(to_tsvector('simple'::regconfig, answer), 'D')
      ) STORED,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function createHnswIndex(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS semantic_qa_records_embedding_hnsw
      ON semantic_qa.records USING hnsw (embedding vector_cosine_ops)
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
}

async function getCorpus(client) {
  const result = await client.query(`
    SELECT id, source_mapping AS "sourceMapping", embedding_model AS "embeddingModel",
           embedding_dimension AS "embeddingDimension", embedding_format_version AS "embeddingFormatVersion",
           retrieval_schema_version AS "retrievalSchemaVersion",
           ollama_base_url AS "ollamaBaseUrl",
           record_count::bigint AS "recordCount", last_synced_at AS "lastSyncedAt", updated_at AS "updatedAt"
    FROM semantic_qa.corpus WHERE id = 'default'
  `);
  if (!result.rows[0]) return null;
  return { ...result.rows[0], recordCount: Number(result.rows[0].recordCount) };
}

async function initializeIndex(connection, { model, dimension, ollamaBaseUrl }) {
  return withPool(connection, async (pool) => {
    const client = await pool.connect();
    try {
      await ensureCoreSchema(client);
      const existingCorpus = await getCorpus(client);
      const exists = await recordsTableExists(client);
      if (!exists) {
        await createRecordsTable(client, 'records', dimension);
      }
      await createHnswIndex(client);
      await createSearchIndex(client);
      if (!existingCorpus) {
        const formatVersion = embeddingFormatForModel(model);
        await client.query(`
          INSERT INTO semantic_qa.corpus
            (id, source_mapping, embedding_model, embedding_dimension, embedding_format_version, ollama_base_url)
          VALUES ('default', '{}'::jsonb, $1, $2, $3, $4)
        `, [model, dimension, formatVersion, ollamaBaseUrl]);
      }
      const corpus = existingCorpus || await getCorpus(client);
      const requiresRebuild = corpus.embeddingModel !== model ||
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
      const corpus = await getCorpus(client);
      const count = exists ? await client.query('SELECT COUNT(*)::bigint AS count FROM semantic_qa.records') : { rows: [{ count: 0 }] };
      const runs = await client.query(`
        SELECT id, mode, status, processed::bigint AS processed, changed::bigint AS changed,
               total::bigint AS total, error, started_at AS "startedAt", finished_at AS "finishedAt"
        FROM semantic_qa.sync_runs ORDER BY started_at DESC LIMIT 10
      `);
      return {
        initialized: Boolean(corpus && exists),
        corpus,
        recordCount: Number(count.rows[0].count),
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
  return { stage: `records_stage_${suffix}`, seen: `records_seen_${suffix}` };
}

async function createSyncStage(client, jobId, dimension) {
  const names = stageNames(jobId);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.stage)}`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.seen)}`);
  await createRecordsTable(client, names.stage, dimension, { unlogged: true });
  await client.query(`CREATE UNLOGGED TABLE semantic_qa.${quoteIdentifier(names.seen)} (source_id text PRIMARY KEY)`);
  return names;
}

async function dropSyncStage(client, names) {
  if (!names) return;
  await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.stage)}`);
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

async function commitIncremental(client, { names, mapping, model, dimension, formatVersion, retrievalVersion, ollamaBaseUrl, total }) {
  await client.query('BEGIN');
  try {
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
      UPDATE semantic_qa.corpus SET source_mapping = $1::jsonb, embedding_model = $2,
        embedding_dimension = $3, embedding_format_version = $4, retrieval_schema_version = $5,
        ollama_base_url = $6, record_count = $7,
        last_synced_at = now(), updated_at = now() WHERE id = 'default'
    `, [JSON.stringify(mapping), model, dimension, formatVersion, retrievalVersion, ollamaBaseUrl, total]);
    await dropSyncStage(client, names);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function commitRebuild(client, { names, mapping, model, dimension, formatVersion, retrievalVersion, ollamaBaseUrl, total }) {
  await client.query('BEGIN');
  try {
    await client.query('DROP TABLE IF EXISTS semantic_qa.records');
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.stage)} SET LOGGED`);
    await client.query(`ALTER TABLE semantic_qa.${quoteIdentifier(names.stage)} RENAME TO records`);
    await client.query(`ALTER TABLE semantic_qa.records RENAME CONSTRAINT ${quoteIdentifier(`${names.stage}_pkey`)} TO records_pkey`);
    await client.query(`DROP TABLE IF EXISTS semantic_qa.${quoteIdentifier(names.seen)}`);
    await createHnswIndex(client);
    await createSearchIndex(client);
    await client.query(`
      INSERT INTO semantic_qa.corpus
        (id, source_mapping, embedding_model, embedding_dimension, embedding_format_version,
         retrieval_schema_version, ollama_base_url, record_count, last_synced_at, updated_at)
      VALUES ('default', $1::jsonb, $2, $3, $4, $5, $6, $7, now(), now())
      ON CONFLICT (id) DO UPDATE SET source_mapping = EXCLUDED.source_mapping,
        embedding_model = EXCLUDED.embedding_model, embedding_dimension = EXCLUDED.embedding_dimension,
        embedding_format_version = EXCLUDED.embedding_format_version,
        retrieval_schema_version = EXCLUDED.retrieval_schema_version,
        ollama_base_url = EXCLUDED.ollama_base_url, record_count = EXCLUDED.record_count,
        last_synced_at = now(), updated_at = now()
    `, [JSON.stringify(mapping), model, dimension, formatVersion, retrievalVersion, ollamaBaseUrl, total]);
    await client.query('COMMIT');
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
      const vectorLiteral = toVectorLiteral(vector);
      const candidateLimit = Math.max(10, Math.min(200, Number(limit) || 60));
      const hasLexicalIndex = await searchVectorExists(client);
      const result = hasLexicalIndex
        ? await client.query(`
          WITH query AS (SELECT websearch_to_tsquery('simple'::regconfig, $2) AS terms),
          dense AS MATERIALIZED (
            SELECT source_id FROM semantic_qa.records
            ORDER BY embedding <=> $1::vector LIMIT $3
          ),
          lexical AS MATERIALIZED (
            SELECT r.source_id FROM semantic_qa.records r CROSS JOIN query q
            WHERE q.terms::text <> '' AND r.search_vector @@ q.terms
            ORDER BY ts_rank_cd(r.search_vector, q.terms) DESC LIMIT $3
          ),
          candidates AS (SELECT source_id FROM dense UNION SELECT source_id FROM lexical)
          SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
                 r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
                 1 - (r.embedding <=> $1::vector) AS similarity,
                 ts_rank_cd(r.search_vector, q.terms) AS "lexicalScore"
          FROM candidates c
          JOIN semantic_qa.records r USING (source_id)
          CROSS JOIN query q
        `, [vectorLiteral, queryText, candidateLimit])
        : await client.query(`
          SELECT source_id AS "sourceId", question, answer, metadata,
                 source_group AS "sourceGroup", source_order AS "sourceOrder",
                 1 - (embedding <=> $1::vector) AS similarity,
                 0::real AS "lexicalScore"
          FROM semantic_qa.records
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `, [vectorLiteral, candidateLimit]);

      const expandableGroups = [...new Set(result.rows
        .filter((row) => row.sourceGroup != null && Number(row.metadata?.chunk_count) > 1 && Number(row.metadata?.chunk_count) <= 100)
        .map((row) => row.sourceGroup))];
      let siblingRows = [];
      if (expandableGroups.length) {
        siblingRows = hasLexicalIndex
          ? (await client.query(`
            WITH query AS (SELECT websearch_to_tsquery('simple'::regconfig, $2) AS terms)
            SELECT r.source_id AS "sourceId", r.question, r.answer, r.metadata,
                   r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
                   1 - (r.embedding <=> $1::vector) AS similarity,
                   ts_rank_cd(r.search_vector, q.terms) AS "lexicalScore"
            FROM semantic_qa.records r CROSS JOIN query q
            WHERE r.source_group = ANY($3::text[])
          `, [vectorLiteral, queryText, expandableGroups])).rows
          : (await client.query(`
            SELECT source_id AS "sourceId", question, answer, metadata,
                   source_group AS "sourceGroup", source_order AS "sourceOrder",
                   1 - (embedding <=> $1::vector) AS similarity,
                   0::real AS "lexicalScore"
            FROM semantic_qa.records WHERE source_group = ANY($2::text[])
          `, [vectorLiteral, expandableGroups])).rows;
      }
      const unique = new Map([...result.rows, ...siblingRows].map((row) => [row.sourceId, row]));
      return { corpus, rows: [...unique.values()], hybrid: hasLexicalIndex };
    } finally {
      client.release();
    }
  });
}

module.exports = {
  connectionToPoolConfig,
  createPool,
  withPool,
  testPostgresConnection,
  discoverSourceCatalog,
  validateMapping,
  openSourceSnapshot,
  ensureCoreSchema,
  recordsTableExists,
  initializeIndex,
  testIndexConnection,
  getIndexStatus,
  getCorpus,
  createSyncStage,
  dropSyncStage,
  insertSeen,
  getExistingHashes,
  insertStageRecords,
  createSyncRun,
  updateSyncRun,
  commitIncremental,
  commitRebuild,
  searchIndex,
};
