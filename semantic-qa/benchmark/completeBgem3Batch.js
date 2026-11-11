const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');
const { execSync } = require('node:child_process');
const path = require('node:path');

const OLLAMA_URL = 'http://127.0.0.1:11434';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBatchEmbeddingsWithRetry(texts, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'bge-m3', input: texts }),
      });
      const data = await res.json();
      if (!data.embeddings) throw new Error(data.error || JSON.stringify(data));
      return data.embeddings;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      process.stderr.write(`\nTransient embedding error (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in 2s...\n`);
      await sleep(2000);
    }
  }
}

function toVectorLiteral(arr) {
  return `[${arr.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

async function run() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_index' });
  await client.connect();

  console.log('--- Completing Remaining BGE-M3 Embeddings (Resilient Mode) ---');

  const missingRes = await client.query(`
    SELECT g.passage_id, g.source_id, g.passage_index, g.answer_unit_id,
           g.passage_text, g.char_length, g.start_offset, g.end_offset,
           g.unit_kind, g.associated_question, doc.title
    FROM semantic_qa_bench.passages_gemma g
    JOIN semantic_qa_bench.documents doc ON doc.document_id = g.source_id
    WHERE g.passage_id NOT IN (SELECT passage_id FROM semantic_qa_bench.passages_bgem3)
    ORDER BY g.source_id, g.passage_index;
  `);

  const missing = missingRes.rows;
  console.log(`Remaining passages to embed for BGE-M3: ${missing.length}`);

  if (missing.length === 0) {
    console.log('All BGE-M3 passages already embedded!');
  } else {
    const BATCH_SIZE = 16;
    const t0 = Date.now();

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const inputTexts = batch.map(p => {
        const title = String(p.title || '').trim();
        const q = String(p.associated_question || '').slice(0, 350).trim();
        const header = [title, q].filter(Boolean).join(' — ');
        return header ? `${header}\n\n${p.passage_text}` : p.passage_text;
      });

      const vectors = await fetchBatchEmbeddingsWithRetry(inputTexts);

      for (let j = 0; j < batch.length; j++) {
        const p = batch[j];
        const vecLiteral = toVectorLiteral(vectors[j]);
        await client.query(`
          INSERT INTO semantic_qa_bench.passages_bgem3
          (passage_id, source_id, passage_index, answer_unit_id, passage_text, char_length, start_offset, end_offset, unit_kind, associated_question, context_text, embedding)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)
          ON CONFLICT (passage_id) DO NOTHING
        `, [
          p.passage_id, p.source_id, p.passage_index, p.answer_unit_id, p.passage_text,
          p.char_length, p.start_offset, p.end_offset, p.unit_kind, p.associated_question,
          inputTexts[j], vecLiteral,
        ]);
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const speed = ((i + batch.length) / elapsed).toFixed(1);
      process.stdout.write(`Batch Embedded BGE-M3: ${Math.min(i + BATCH_SIZE, missing.length)} / ${missing.length} (${speed} passages/sec)\r`);

      // Gentle pause to prevent Windows ephemeral socket exhaustion
      await sleep(80);
    }

    const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nFinished BGE-M3 embedding in ${totalTime}s!`);
  }

  const countRes = await client.query(`SELECT count(*) FROM semantic_qa_bench.passages_bgem3;`);
  console.log(`Total BGE-M3 passages stored: ${countRes.rows[0].count} / 3284`);
  await client.end();

  console.log('\n=== Launching Full Evaluation Benchmark Now ===\n');
  const evalScript = path.join(__dirname, 'evaluateBenchmark.js');
  execSync(`node "${evalScript}"`, { stdio: 'inherit' });
}

run().catch(console.error);
