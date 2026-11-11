const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');

async function setupSchema() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_index' });
  await client.connect();

  console.log('--- Setting up isolated schema: semantic_qa_bench ---');

  await client.query(`CREATE SCHEMA IF NOT EXISTS semantic_qa_bench;`);

  // Drop tables in benchmark schema if they exist
  await client.query(`DROP TABLE IF EXISTS semantic_qa_bench.passages_bgem3 CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa_bench.passages_gemma CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa_bench.answer_units CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS semantic_qa_bench.documents CASCADE;`);

  // 1. Documents
  await client.query(`
    CREATE TABLE semantic_qa_bench.documents (
      document_id text PRIMARY KEY,
      source_type text NOT NULL,
      original_record_id bigint NOT NULL,
      title text NOT NULL,
      question_context text NOT NULL DEFAULT '',
      display_text text NOT NULL,
      author text NOT NULL DEFAULT 'Swami',
      language text NOT NULL DEFAULT '',
      record_date timestamp,
      multimedia_filename text NOT NULL DEFAULT ''
    );
  `);

  // 2. Answer Units
  await client.query(`
    CREATE TABLE semantic_qa_bench.answer_units (
      answer_unit_id text PRIMARY KEY,
      source_id text NOT NULL REFERENCES semantic_qa_bench.documents(document_id) ON DELETE CASCADE,
      unit_index integer NOT NULL,
      unit_kind text NOT NULL,
      author text NOT NULL DEFAULT 'Swami',
      associated_question text NOT NULL DEFAULT '',
      language text NOT NULL DEFAULT '',
      start_offset integer NOT NULL,
      end_offset integer NOT NULL,
      unit_text text NOT NULL,
      content_hash text NOT NULL
    );
    CREATE INDEX idx_bench_units_source ON semantic_qa_bench.answer_units(source_id, unit_index);
  `);

  // 3. Passages for Gemma (768 dimensions)
  await client.query(`
    CREATE TABLE semantic_qa_bench.passages_gemma (
      passage_id text PRIMARY KEY,
      source_id text NOT NULL REFERENCES semantic_qa_bench.documents(document_id) ON DELETE CASCADE,
      passage_index integer NOT NULL,
      answer_unit_id text NOT NULL REFERENCES semantic_qa_bench.answer_units(answer_unit_id) ON DELETE CASCADE,
      passage_text text NOT NULL,
      char_length integer NOT NULL,
      start_offset integer NOT NULL,
      end_offset integer NOT NULL,
      unit_kind text NOT NULL,
      associated_question text NOT NULL DEFAULT '',
      context_text text NOT NULL,
      embedding vector(768) NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, associated_question), 'A') ||
        setweight(to_tsvector('simple'::regconfig, passage_text), 'B')
      ) STORED
    );
    CREATE INDEX idx_bench_gemma_hnsw ON semantic_qa_bench.passages_gemma USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
    CREATE INDEX idx_bench_gemma_gin ON semantic_qa_bench.passages_gemma USING gin (search_vector);
    CREATE INDEX idx_bench_gemma_trgm ON semantic_qa_bench.passages_gemma USING gin (passage_text gin_trgm_ops);
  `);

  // 4. Passages for BGE-M3 (1024 dimensions)
  await client.query(`
    CREATE TABLE semantic_qa_bench.passages_bgem3 (
      passage_id text PRIMARY KEY,
      source_id text NOT NULL REFERENCES semantic_qa_bench.documents(document_id) ON DELETE CASCADE,
      passage_index integer NOT NULL,
      answer_unit_id text NOT NULL REFERENCES semantic_qa_bench.answer_units(answer_unit_id) ON DELETE CASCADE,
      passage_text text NOT NULL,
      char_length integer NOT NULL,
      start_offset integer NOT NULL,
      end_offset integer NOT NULL,
      unit_kind text NOT NULL,
      associated_question text NOT NULL DEFAULT '',
      context_text text NOT NULL,
      embedding vector(1024) NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, associated_question), 'A') ||
        setweight(to_tsvector('simple'::regconfig, passage_text), 'B')
      ) STORED
    );
    CREATE INDEX idx_bench_bgem3_hnsw ON semantic_qa_bench.passages_bgem3 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
    CREATE INDEX idx_bench_bgem3_gin ON semantic_qa_bench.passages_bgem3 USING gin (search_vector);
    CREATE INDEX idx_bench_bgem3_trgm ON semantic_qa_bench.passages_bgem3 USING gin (passage_text gin_trgm_ops);
  `);

  console.log('Schema and tables created successfully.');
  await client.end();
}

setupSchema().catch(console.error);
