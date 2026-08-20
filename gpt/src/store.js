const crypto = require('node:crypto');
const { ConfigurablePool } = require('./postgres');

function id() { return crypto.randomUUID(); }
function titleFromMessage(value) {
  const compact = String(value || '').replace(/\s+/gu, ' ').trim();
  return compact.length > 72 ? `${compact.slice(0, 69).trim()}…` : compact || 'New conversation';
}

class GptStore {
  constructor() {
    this.holder = new ConfigurablePool({ applicationName: 'local-corpus-gpt-chat' });
  }

  async configure(connection) { return this.holder.configure(connection); }

  async initialize(connection) {
    const pool = await this.configure(connection);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gpt.conversations (
        id text PRIMARY KEY,
        title text NOT NULL,
        memory jsonb NOT NULL DEFAULT '{}'::jsonb,
        model_tag text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS gpt.turns (
        id text PRIMARY KEY,
        conversation_id text NOT NULL REFERENCES gpt.conversations(id) ON DELETE CASCADE,
        status text NOT NULL,
        objective jsonb,
        probes jsonb NOT NULL DEFAULT '[]'::jsonb,
        model_tag text,
        model_digest text,
        model_options jsonb NOT NULL DEFAULT '{}'::jsonb,
        corpus_fingerprint jsonb,
        stats jsonb NOT NULL DEFAULT '{}'::jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS gpt.messages (
        id text PRIMARY KEY,
        conversation_id text NOT NULL REFERENCES gpt.conversations(id) ON DELETE CASCADE,
        turn_id text REFERENCES gpt.turns(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('user', 'assistant')),
        content text NOT NULL,
        status text NOT NULL DEFAULT 'complete',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS gpt_messages_conversation_created
        ON gpt.messages (conversation_id, created_at, id);
      CREATE TABLE IF NOT EXISTS gpt.evidence (
        id text PRIMARY KEY,
        turn_id text NOT NULL REFERENCES gpt.turns(id) ON DELETE CASCADE,
        evidence_key text NOT NULL,
        citation_number integer,
        source_id text NOT NULL,
        source_group text,
        passage_index integer NOT NULL,
        start_offset integer NOT NULL,
        end_offset integer NOT NULL,
        excerpt text NOT NULL,
        title text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        locator jsonb NOT NULL DEFAULT '{}'::jsonb,
        channels jsonb NOT NULL DEFAULT '[]'::jsonb,
        scores jsonb NOT NULL DEFAULT '{}'::jsonb,
        adjudication jsonb NOT NULL DEFAULT '{}'::jsonb,
        cited boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (turn_id, evidence_key)
      );
      CREATE TABLE IF NOT EXISTS gpt.settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS gpt.benchmark_runs (
        id text PRIMARY KEY,
        model_tag text NOT NULL,
        model_digest text,
        status text NOT NULL,
        seeds jsonb NOT NULL DEFAULT '[]'::jsonb,
        metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
        recommendation text,
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      );
    `);
    return this.health();
  }

  pool() {
    if (!this.holder.pool) throw new Error('Conversation database is not configured');
    return this.holder.pool;
  }

  async health() {
    const result = await this.pool().query(`SELECT current_database() AS database, current_user AS "user",
      to_regclass('gpt.conversations') IS NOT NULL AS initialized`);
    return result.rows[0];
  }

  async persistSettings(value) {
    await this.pool().query(`INSERT INTO gpt.settings (key, value) VALUES ('runtime', $1::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(value)]);
  }

  async loadSettings() {
    const result = await this.pool().query(`SELECT value FROM gpt.settings WHERE key = 'runtime'`);
    return result.rows[0]?.value || null;
  }

  async listConversations() {
    const result = await this.pool().query(`
      SELECT c.id, c.title, c.model_tag AS "modelTag", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
             count(m.id)::integer AS "messageCount"
      FROM gpt.conversations c LEFT JOIN gpt.messages m ON m.conversation_id = c.id
      GROUP BY c.id ORDER BY c.updated_at DESC
    `);
    return result.rows;
  }

  async createConversation(title = 'New conversation') {
    const conversationId = id();
    const result = await this.pool().query(`INSERT INTO gpt.conversations (id, title) VALUES ($1, $2)
      RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt"`, [conversationId, titleFromMessage(title)]);
    return result.rows[0];
  }

  async renameConversation(conversationId, title) {
    const result = await this.pool().query(`UPDATE gpt.conversations SET title = $2, updated_at = now() WHERE id = $1
      RETURNING id, title, updated_at AS "updatedAt"`, [conversationId, titleFromMessage(title)]);
    if (!result.rows[0]) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
    return result.rows[0];
  }

  async deleteConversation(conversationId) {
    const result = await this.pool().query('DELETE FROM gpt.conversations WHERE id = $1 RETURNING id', [conversationId]);
    if (!result.rows[0]) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
    return { id: conversationId };
  }

  async getConversation(conversationId) {
    const conversation = await this.pool().query(`SELECT id, title, memory, model_tag AS "modelTag",
      created_at AS "createdAt", updated_at AS "updatedAt" FROM gpt.conversations WHERE id = $1`, [conversationId]);
    if (!conversation.rows[0]) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
    const messages = await this.pool().query(`
      SELECT m.id, m.turn_id AS "turnId", m.role, m.content, m.status, m.created_at AS "createdAt",
             coalesce((SELECT t.stats FROM gpt.turns t WHERE t.id = m.turn_id), '{}'::jsonb) AS "researchDetails",
             coalesce((SELECT jsonb_agg(jsonb_build_object(
               'id', e.id, 'key', e.evidence_key, 'citationNumber', e.citation_number,
               'sourceId', e.source_id, 'sourceGroup', e.source_group, 'passageIndex', e.passage_index,
               'start', e.start_offset, 'end', e.end_offset, 'excerpt', e.excerpt, 'title', e.title,
               'metadata', e.metadata, 'locator', e.locator, 'channels', e.channels, 'scores', e.scores,
               'adjudication', e.adjudication
             ) ORDER BY e.citation_number NULLS LAST, e.evidence_key)
             FROM gpt.evidence e WHERE e.turn_id = m.turn_id AND e.cited), '[]'::jsonb) AS sources
      FROM gpt.messages m WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id
    `, [conversationId]);
    return { ...conversation.rows[0], messages: messages.rows };
  }

  async recentContext(conversationId) {
    const conversation = await this.pool().query('SELECT memory FROM gpt.conversations WHERE id = $1', [conversationId]);
    if (!conversation.rows[0]) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
    const messages = await this.pool().query(`SELECT role, content FROM gpt.messages
      WHERE conversation_id = $1 AND status = 'complete' ORDER BY created_at DESC, id DESC LIMIT 12`, [conversationId]);
    const evidence = await this.pool().query(`
      SELECT e.evidence_key AS "key", e.source_id AS "sourceId", e.passage_index AS "passageIndex",
             e.excerpt, e.title, e.metadata
      FROM gpt.evidence e JOIN gpt.turns t ON t.id = e.turn_id
      WHERE t.conversation_id = $1 AND e.cited ORDER BY e.created_at DESC LIMIT 12
    `, [conversationId]);
    return { memory: conversation.rows[0].memory || {}, messages: messages.rows.reverse(), priorEvidence: evidence.rows };
  }

  async beginTurn(conversationId, question) {
    const client = await this.pool().connect();
    const turnId = id();
    const userMessageId = id();
    try {
      await client.query('BEGIN');
      const conversation = await client.query('SELECT title FROM gpt.conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      if (!conversation.rows[0]) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
      await client.query(`INSERT INTO gpt.turns (id, conversation_id, status) VALUES ($1, $2, 'running')`, [turnId, conversationId]);
      await client.query(`INSERT INTO gpt.messages (id, conversation_id, turn_id, role, content)
        VALUES ($1, $2, $3, 'user', $4)`, [userMessageId, conversationId, turnId, question]);
      const count = await client.query(`SELECT count(*)::integer AS count FROM gpt.messages WHERE conversation_id = $1`, [conversationId]);
      if (Number(count.rows[0].count) === 1) {
        await client.query('UPDATE gpt.conversations SET title = $2, updated_at = now() WHERE id = $1', [conversationId, titleFromMessage(question)]);
      } else {
        await client.query('UPDATE gpt.conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      }
      await client.query('COMMIT');
      return { turnId, userMessageId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async updateTurn(turnId, fields = {}) {
    await this.pool().query(`UPDATE gpt.turns SET objective = coalesce($2::jsonb, objective), probes = coalesce($3::jsonb, probes),
      model_tag = coalesce($4, model_tag), model_digest = coalesce($5, model_digest), model_options = coalesce($6::jsonb, model_options),
      corpus_fingerprint = coalesce($7::jsonb, corpus_fingerprint), stats = coalesce($8::jsonb, stats)
      WHERE id = $1`, [turnId, fields.objective ? JSON.stringify(fields.objective) : null,
      fields.probes ? JSON.stringify(fields.probes) : null, fields.modelTag || null, fields.modelDigest || null,
      fields.modelOptions ? JSON.stringify(fields.modelOptions) : null,
      fields.corpusFingerprint ? JSON.stringify(fields.corpusFingerprint) : null,
      fields.stats ? JSON.stringify(fields.stats) : null]);
  }

  async completeTurn({ turnId, conversationId, answer, memory, modelTag, evidence, stats }) {
    const client = await this.pool().connect();
    const assistantMessageId = id();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO gpt.messages (id, conversation_id, turn_id, role, content)
        VALUES ($1, $2, $3, 'assistant', $4)`, [assistantMessageId, conversationId, turnId, answer]);
      for (const item of evidence || []) {
        await client.query(`INSERT INTO gpt.evidence
          (id, turn_id, evidence_key, citation_number, source_id, source_group, passage_index, start_offset, end_offset,
           excerpt, title, metadata, locator, channels, scores, adjudication, cited)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17)`, [
          id(), turnId, item.key, item.citationNumber || null, item.sourceId, item.sourceGroup || null,
          item.passageIndex, item.start, item.end, item.excerpt, item.title || null,
          JSON.stringify(item.metadata || {}), JSON.stringify(item.locator || {}), JSON.stringify(item.channels || []),
          JSON.stringify(item.scores || {}), JSON.stringify(item.adjudication || {}), Boolean(item.cited),
        ]);
      }
      await client.query(`UPDATE gpt.turns SET status = 'complete', stats = $2::jsonb, finished_at = now() WHERE id = $1`, [turnId, JSON.stringify(stats || {})]);
      await client.query(`UPDATE gpt.conversations SET memory = $2::jsonb, model_tag = $3, updated_at = now() WHERE id = $1`,
        [conversationId, JSON.stringify(memory || {}), modelTag]);
      await client.query('COMMIT');
      return { assistantMessageId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async failTurn(turnId, status, error) {
    await this.pool().query(`UPDATE gpt.turns SET status = $2, error = $3, finished_at = now() WHERE id = $1`,
      [turnId, status, String(error || '').slice(0, 4000)]);
  }

  async latestUserQuestion(conversationId) {
    const result = await this.pool().query(`SELECT content FROM gpt.messages WHERE conversation_id = $1 AND role = 'user'
      ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId]);
    if (!result.rows[0]) throw Object.assign(new Error('No user message to regenerate'), { statusCode: 409 });
    return result.rows[0].content;
  }

  async turnConversation(turnId) {
    const result = await this.pool().query(`SELECT conversation_id AS "conversationId" FROM gpt.turns WHERE id = $1`, [turnId]);
    if (!result.rows[0]) throw Object.assign(new Error('Turn not found'), { statusCode: 404 });
    return result.rows[0].conversationId;
  }

  async listBenchmarks() {
    const result = await this.pool().query(`SELECT id, model_tag AS "modelTag", model_digest AS "modelDigest", status, seeds,
      metrics, recommendation, created_at AS "createdAt", finished_at AS "finishedAt"
      FROM gpt.benchmark_runs ORDER BY created_at DESC LIMIT 20`);
    return result.rows;
  }

  async saveBenchmark(run) {
    const runId = run.id || id();
    await this.pool().query(`INSERT INTO gpt.benchmark_runs
      (id, model_tag, model_digest, status, seeds, metrics, recommendation, finished_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,CASE WHEN $4 IN ('complete','failed') THEN now() END)
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, metrics=EXCLUDED.metrics,
        recommendation=EXCLUDED.recommendation, finished_at=EXCLUDED.finished_at`, [runId, run.modelTag, run.modelDigest || null,
      run.status || 'complete', JSON.stringify(run.seeds || []), JSON.stringify(run.metrics || {}), run.recommendation || null]);
    return { id: runId };
  }

  async close() { await this.holder.close(); }
}

module.exports = { GptStore, titleFromMessage };
