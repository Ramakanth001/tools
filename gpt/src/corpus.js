const { ConfigurablePool } = require('./postgres');
const { RETRIEVAL_SCHEMA_VERSION, EMBEDDING_FORMATS } = require('./config');

function toVectorLiteral(vector) {
  if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error('Embedding vector is empty or invalid');
  }
  return `[${vector.map((value) => Number(value).toString()).join(',')}]`;
}

function quotedPhrases(value) {
  const found = [];
  const add = (candidate) => {
    const text = String(candidate || '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
      .replace(/^[\s"'‘’“”:,.-]+|[\s"'‘’“”?!,.;:-]+$/gu, '');
    const words = text.match(/[\p{L}\p{N}]+/gu)?.length || 0;
    if (text.length >= 6 && text.length <= 180 && words >= 2 && !found.some((item) => item.toLocaleLowerCase() === text.toLocaleLowerCase())) found.push(text);
  };
  for (const match of String(value || '').matchAll(/"([^"\n]{3,})"|“([^”\n]{3,})”|'([^'\n]{3,})'|‘([^’\n]{3,})’/gu)) {
    add(match.slice(1).find(Boolean));
  }
  return found.slice(0, 5);
}

function contractFingerprint(contract) {
  return {
    retrievalSchemaVersion: contract.retrievalSchemaVersion,
    embeddingFormatVersion: contract.embeddingFormatVersion,
    embeddingModel: contract.embeddingModel,
    embeddingModelDigest: contract.embeddingModelDigest,
    embeddingDimension: Number(contract.embeddingDimension),
    recordCount: Number(contract.recordCount),
    lastSyncedAt: contract.lastSyncedAt ? new Date(contract.lastSyncedAt).toISOString() : null,
  };
}

function sameFingerprint(left, right) { return JSON.stringify(contractFingerprint(left)) === JSON.stringify(contractFingerprint(right)); }

class CorpusReader {
  constructor() {
    this.holder = new ConfigurablePool({ readOnly: true, applicationName: 'local-corpus-gpt-index-reader' });
  }

  async configure(connection) { return this.holder.configure(connection); }
  pool() {
    if (!this.holder.pool) throw new Error('Corpus database is not configured');
    return this.holder.pool;
  }

  async inspect(connection) {
    const pool = await this.configure(connection);
    const result = await pool.query(`
      SELECT current_database() AS database, current_user AS "user",
             to_regclass('semantic_qa.corpus') IS NOT NULL AS "hasCorpus",
             to_regclass('semantic_qa.records') IS NOT NULL AS "hasRecords",
             to_regclass('semantic_qa.passages') IS NOT NULL AS "hasPassages",
             has_schema_privilege(current_user, 'semantic_qa', 'USAGE') AS "schemaUsage",
             CASE WHEN to_regclass('semantic_qa.records') IS NULL THEN false
                  ELSE has_table_privilege(current_user, 'semantic_qa.records', 'SELECT') END AS "recordsSelect",
             CASE WHEN to_regclass('semantic_qa.passages') IS NULL THEN false
                  ELSE has_table_privilege(current_user, 'semantic_qa.passages', 'SELECT') END AS "passagesSelect"
    `);
    const status = result.rows[0];
    if (!status.hasCorpus || !status.hasRecords || !status.hasPassages) {
      throw Object.assign(new Error('The corpus index is incomplete; semantic_qa.corpus, records, and passages are required.'), { statusCode: 409 });
    }
    if (!status.schemaUsage || !status.recordsSelect || !status.passagesSelect) {
      throw Object.assign(new Error('The configured corpus account needs read-only SELECT access to the semantic_qa index tables.'), { statusCode: 403 });
    }
    const corpus = await pool.query(`
      SELECT id, embedding_model AS "embeddingModel", embedding_model_digest AS "embeddingModelDigest",
             embedding_dimension AS "embeddingDimension", embedding_format_version AS "embeddingFormatVersion",
             retrieval_schema_version AS "retrievalSchemaVersion", record_count AS "recordCount",
             last_synced_at AS "lastSyncedAt", updated_at AS "updatedAt"
      FROM semantic_qa.corpus WHERE id = 'default'
    `);
    if (!corpus.rows[0]) throw Object.assign(new Error('No active corpus index was found.'), { statusCode: 409 });
    const contract = corpus.rows[0];
    if (contract.retrievalSchemaVersion !== RETRIEVAL_SCHEMA_VERSION) {
      throw Object.assign(new Error(`GPT requires retrieval schema ${RETRIEVAL_SCHEMA_VERSION}; the index reports ${contract.retrievalSchemaVersion || 'unknown'}.`), { statusCode: 409 });
    }
    if (!EMBEDDING_FORMATS.has(contract.embeddingFormatVersion)) {
      throw Object.assign(new Error(`GPT cannot query embedding format ${contract.embeddingFormatVersion || 'unknown'} safely.`), { statusCode: 409 });
    }
    return { ...status, contract: contractFingerprint(contract) };
  }

  async currentContract() {
    const result = await this.pool().query(`SELECT embedding_model AS "embeddingModel",
      embedding_model_digest AS "embeddingModelDigest", embedding_dimension AS "embeddingDimension",
      embedding_format_version AS "embeddingFormatVersion", retrieval_schema_version AS "retrievalSchemaVersion",
      record_count AS "recordCount", last_synced_at AS "lastSyncedAt"
      FROM semantic_qa.corpus WHERE id = 'default'`);
    if (!result.rows[0]) throw new Error('The active corpus contract disappeared');
    return contractFingerprint(result.rows[0]);
  }

  async searchProbe(vector, query, { channelLimit = 40, resultLimit = 60, signal } = {}) {
    const client = await this.pool().connect();
    const phrases = quotedPhrases(query);
    const queryWordCount = String(query || '').match(/[\p{L}\p{N}]+/gu)?.length || 0;
    const allowFuzzy = !phrases.length && queryWordCount > 0 && queryWordCount <= 4;
    let released = false;
    const release = (destroy = false) => {
      if (!released) { released = true; client.release(destroy); }
    };
    const onAbort = () => release(true);
    try {
      if (signal?.aborted) throw Object.assign(new Error('Retrieval cancelled'), { name: 'AbortError' });
      signal?.addEventListener('abort', onAbort, { once: true });
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL hnsw.ef_search = 200');
      await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = 0.24`);
      const result = await client.query(`
        WITH input AS MATERIALIZED (
          SELECT $1::vector AS embedding, $2::text AS text,
                 websearch_to_tsquery('simple'::regconfig, $2) AS terms,
                 $4::text[] AS phrases
        ),
        dense AS MATERIALIZED (
          SELECT p.source_id, p.passage_index,
                 row_number() OVER (ORDER BY p.embedding <=> i.embedding, p.source_id, p.passage_index) AS rank,
                 'dense'::text AS channel, 1.0::float8 AS weight
          FROM semantic_qa.passages p CROSS JOIN input i
          ORDER BY p.embedding <=> i.embedding, p.source_id, p.passage_index LIMIT $3
        ),
        passage_lexical AS MATERIALIZED (
          SELECT p.source_id, p.passage_index,
                 row_number() OVER (ORDER BY ts_rank_cd(p.search_vector, i.terms) DESC, p.source_id, p.passage_index) AS rank,
                 'passage_lexical'::text AS channel, 0.8::float8 AS weight
          FROM semantic_qa.passages p CROSS JOIN input i
          WHERE i.terms::text <> '' AND p.search_vector @@ i.terms
          ORDER BY ts_rank_cd(p.search_vector, i.terms) DESC, p.source_id, p.passage_index LIMIT $3
        ),
        exact_phrase AS MATERIALIZED (
          SELECT p.source_id, p.passage_index,
                 row_number() OVER (ORDER BY max(length(phrase)) DESC, length(p.passage_text), p.source_id, p.passage_index) AS rank,
                 'exact_phrase'::text AS channel, 3.0::float8 AS weight
          FROM semantic_qa.passages p CROSS JOIN input i CROSS JOIN LATERAL unnest(i.phrases) phrase
          WHERE position(lower(phrase) in lower(p.passage_text)) > 0
          GROUP BY p.source_id, p.passage_index, p.passage_text
          ORDER BY max(length(phrase)) DESC, length(p.passage_text), p.source_id, p.passage_index LIMIT $3
        ),
        title_matches AS MATERIALIZED (
          SELECT r.source_id,
                 row_number() OVER (ORDER BY ts_rank_cd(to_tsvector('simple'::regconfig, r.question), i.terms) DESC, r.source_id) AS rank
          FROM semantic_qa.records r CROSS JOIN input i
          WHERE i.terms::text <> '' AND to_tsvector('simple'::regconfig, r.question) @@ i.terms
          ORDER BY ts_rank_cd(to_tsvector('simple'::regconfig, r.question), i.terms) DESC, r.source_id LIMIT $3
        ),
        title_discovery AS MATERIALIZED (
          SELECT t.source_id, p.passage_index, t.rank, 'title_discovery'::text AS channel, 0.35::float8 AS weight
          FROM title_matches t CROSS JOIN input i
          JOIN LATERAL (
            SELECT candidate.passage_index FROM semantic_qa.passages candidate
            WHERE candidate.source_id = t.source_id
            ORDER BY CASE WHEN i.terms::text <> '' AND candidate.search_vector @@ i.terms THEN 0 ELSE 1 END,
                     ts_rank_cd(candidate.search_vector, i.terms) DESC, candidate.passage_index LIMIT 1
          ) p ON true
        ),
        fuzzy AS MATERIALIZED (
          SELECT p.source_id, p.passage_index,
                 row_number() OVER (ORDER BY word_similarity(i.text, p.passage_text) DESC, p.source_id, p.passage_index) AS rank,
                 'fuzzy'::text AS channel, 0.25::float8 AS weight
          FROM semantic_qa.passages p CROSS JOIN input i
          WHERE $6::boolean AND length(i.text) >= 8 AND i.text <% p.passage_text
          ORDER BY word_similarity(i.text, p.passage_text) DESC, p.source_id, p.passage_index LIMIT $3
        ),
        channel_rows AS (
          SELECT * FROM dense UNION ALL SELECT * FROM passage_lexical UNION ALL SELECT * FROM exact_phrase
          UNION ALL SELECT * FROM title_discovery UNION ALL SELECT * FROM fuzzy
        ),
        fused AS MATERIALIZED (
          SELECT source_id, passage_index, sum(weight / (60.0 + rank)) AS score,
                 array_agg(DISTINCT channel ORDER BY channel) AS channels
          FROM channel_rows GROUP BY source_id, passage_index
          ORDER BY score DESC, source_id, passage_index LIMIT $5
        )
        SELECT r.source_id AS "sourceId", r.source_group AS "sourceGroup", r.source_order AS "sourceOrder",
               r.question AS title, r.metadata, p.passage_index AS "passageIndex", p.passage_text AS excerpt,
               p.start_offset AS start, p.end_offset AS "end", f.score, f.channels,
               1 - (p.embedding <=> i.embedding) AS similarity,
               ts_rank_cd(p.search_vector, i.terms) AS "lexicalScore"
        FROM fused f JOIN semantic_qa.passages p USING (source_id, passage_index)
        JOIN semantic_qa.records r USING (source_id) CROSS JOIN input i
        ORDER BY f.score DESC, similarity DESC, r.source_id, p.passage_index
      `, [toVectorLiteral(vector), String(query), Math.max(5, Math.min(60, channelLimit)), phrases,
        Math.max(10, Math.min(100, resultLimit)), allowFuzzy]);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (signal?.aborted) throw Object.assign(new Error('Retrieval cancelled'), { name: 'AbortError' });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      release();
    }
  }

  fuseProbeResults(probeResults, limit = 60) {
    const map = new Map();
    probeResults.forEach(({ probe, rows }, probeIndex) => rows.forEach((row, rowIndex) => {
      const key = `${row.sourceId}:${row.passageIndex}`;
      const current = map.get(key) || {
        ...row, key, channels: [], probes: [], scores: { fused: 0, denseSimilarity: Number(row.similarity) || 0, lexical: Number(row.lexicalScore) || 0 },
      };
      current.scores.fused += 1 / (60 + rowIndex + 1);
      current.scores.denseSimilarity = Math.max(current.scores.denseSimilarity, Number(row.similarity) || 0);
      current.scores.lexical = Math.max(current.scores.lexical, Number(row.lexicalScore) || 0);
      current.channels = [...new Set([...current.channels, ...(row.channels || [])])];
      current.probes.push({ index: probeIndex, text: probe.text, purpose: probe.purpose || 'primary', rank: rowIndex + 1 });
      map.set(key, current);
    }));
    const sorted = [...map.values()].sort((a, b) => b.scores.fused - a.scores.fused || b.scores.denseSimilarity - a.scores.denseSimilarity);
    const groups = new Map();
    return sorted.filter((item) => {
      const group = String(item.sourceGroup || item.sourceId);
      const count = groups.get(group) || 0;
      if (count >= 3) return false;
      groups.set(group, count + 1);
      return true;
    }).slice(0, limit).map((item, index) => ({ ...item, retrievalRank: index + 1 }));
  }

  async expandEvidence(item, window = 1) {
    const result = await this.pool().query(`
      WITH selected AS (
        SELECT p.source_id, p.passage_index, p.passage_text, p.start_offset, p.end_offset,
               r.question, r.answer, r.metadata, r.source_group, r.source_order
        FROM semantic_qa.passages p JOIN semantic_qa.records r USING (source_id)
        WHERE p.source_id = $1 AND p.passage_index
          BETWEEN $2::integer - $3::integer AND $2::integer + $3::integer
      )
      SELECT source_id AS "sourceId", passage_index AS "passageIndex", passage_text AS excerpt,
             start_offset AS start, end_offset AS "end", question AS title, metadata,
             source_group AS "sourceGroup", source_order AS "sourceOrder", answer AS "sourceAnswer"
      FROM selected ORDER BY passage_index
    `, [item.sourceId, item.passageIndex, Math.max(0, Math.min(2, window))]);
    if (!result.rows.length) return [item];
    const center = result.rows.find((row) => Number(row.passageIndex) === Number(item.passageIndex)) || result.rows[0];
    const sourceAnswer = String(center.sourceAnswer || '');
    const expandedStart = Math.min(...result.rows.map((row) => Number(row.start)));
    const expandedEnd = Math.max(...result.rows.map((row) => Number(row.end)));
    let start = expandedStart;
    let end = expandedEnd;
    if (end - start > 1800) {
      const midpoint = (Number(center.start) + Number(center.end)) / 2;
      start = Math.max(expandedStart, Math.min(Math.round(midpoint - 900), expandedEnd - 1800));
      end = Math.min(expandedEnd, start + 1800);
    }
    const excerpt = sourceAnswer.slice(start, end);
    const primary = {
      ...item,
      excerpt,
      start,
      end,
      title: center.title,
      metadata: center.metadata || {},
    };

    const chunkIndex = Number(center.metadata?.chunk_index);
    const chunkCount = Number(center.metadata?.chunk_count);
    if (!center.sourceGroup || !Number.isFinite(chunkIndex) || chunkCount <= 1) return [primary];
    const neighborIndexes = [];
    if (Number(item.passageIndex) === 0 && chunkIndex > 1) neighborIndexes.push(chunkIndex - 1);
    const maxPassage = Math.max(...result.rows.map((row) => Number(row.passageIndex)));
    if (Number(item.passageIndex) >= maxPassage && chunkIndex < chunkCount) neighborIndexes.push(chunkIndex + 1);
    if (!neighborIndexes.length) return [primary];
    const neighbors = await this.pool().query(`
      WITH neighbor_records AS (
        SELECT r.* FROM semantic_qa.records r
        WHERE r.source_group = $1 AND (r.metadata->>'chunk_index')::integer = ANY($2::integer[])
      ), ranked AS (
        SELECT nr.source_id, nr.source_group, nr.source_order, nr.question, nr.metadata,
               p.passage_index, p.passage_text, p.start_offset, p.end_offset,
               row_number() OVER (PARTITION BY nr.source_id ORDER BY
                 CASE WHEN (nr.metadata->>'chunk_index')::integer < $3 THEN p.passage_index END DESC NULLS LAST,
                 CASE WHEN (nr.metadata->>'chunk_index')::integer > $3 THEN p.passage_index END ASC NULLS LAST) AS rn
        FROM neighbor_records nr JOIN semantic_qa.passages p USING (source_id)
      )
      SELECT source_id AS "sourceId", source_group AS "sourceGroup", source_order AS "sourceOrder",
             question AS title, metadata, passage_index AS "passageIndex", passage_text AS excerpt,
             start_offset AS start, end_offset AS "end" FROM ranked WHERE rn = 1
    `, [center.sourceGroup, neighborIndexes, chunkIndex]);
    return [primary, ...neighbors.rows.map((row) => ({
      ...row, key: `${row.sourceId}:${row.passageIndex}`, channels: ['adjacent_chunk'], probes: item.probes || [],
      scores: { ...(item.scores || {}), fused: (item.scores?.fused || 0) * 0.8 }, retrievalRank: item.retrievalRank,
    }))];
  }

  async getSource(sourceId, passageIndex = null) {
    const selected = await this.pool().query(`SELECT source_id AS "sourceId", source_group AS "sourceGroup",
      question AS title, metadata FROM semantic_qa.records WHERE source_id = $1`, [sourceId]);
    if (!selected.rows[0]) throw Object.assign(new Error('Source not found'), { statusCode: 404 });
    const group = selected.rows[0].sourceGroup;
    const records = await this.pool().query(`
      SELECT source_id AS "sourceId", question AS title, answer, metadata, source_order AS "sourceOrder"
      FROM semantic_qa.records WHERE ($2::text IS NOT NULL AND source_group = $2) OR ($2::text IS NULL AND source_id = $1)
      ORDER BY CASE WHEN coalesce(metadata->>'chunk_index','') ~ '^[0-9]+$' THEN (metadata->>'chunk_index')::integer END NULLS LAST,
               source_order NULLS LAST, source_id
    `, [sourceId, group]);
    let highlight = null;
    if (passageIndex != null) {
      const passage = await this.pool().query(`SELECT passage_index AS "passageIndex", passage_text AS excerpt,
        start_offset AS start, end_offset AS "end" FROM semantic_qa.passages WHERE source_id = $1 AND passage_index = $2`,
      [sourceId, Number(passageIndex)]);
      highlight = passage.rows[0] || null;
    }
    return { ...selected.rows[0], records: records.rows, highlight };
  }

  async validateEvidence(items) {
    const evidence = Array.isArray(items) ? items : [];
    if (!evidence.length) return true;
    const sourceIds = [...new Set(evidence.map((item) => String(item.sourceId)))];
    const result = await this.pool().query(`SELECT source_id AS "sourceId", answer
      FROM semantic_qa.records WHERE source_id = ANY($1::text[])`, [sourceIds]);
    const answers = new Map(result.rows.map((row) => [String(row.sourceId), String(row.answer || '')]));
    for (const item of evidence) {
      const answer = answers.get(String(item.sourceId));
      const start = Number(item.start);
      const end = Number(item.end);
      if (answer == null || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > answer.length ||
          answer.slice(start, end) !== String(item.excerpt || '')) {
        throw Object.assign(new Error(`Evidence span ${item.evidenceId || item.key || item.sourceId} no longer matches the indexed source.`), { statusCode: 409 });
      }
    }
    return true;
  }

  async close() { await this.holder.close(); }
}

module.exports = { CorpusReader, quotedPhrases, toVectorLiteral, contractFingerprint, sameFingerprint };
