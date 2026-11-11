const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');
const { parseAnswerUnits, segmentAnswerUnit, buildContextualEmbeddingText } = require('./smartSegmenter');

const OLLAMA_URL = 'http://127.0.0.1:11434';

async function fetchEmbeddingBatch(model, texts) {
  const results = [];
  for (const text of texts) {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    const data = await res.json();
    if (!data.embedding) throw new Error(`Embedding failed for model ${model}: ${JSON.stringify(data)}`);
    results.push(data.embedding);
  }
  return results;
}

function toVectorLiteral(arr) {
  return `[${arr.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

async function run() {
  const sourceClient = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_source' });
  const indexClient = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_index' });
  await sourceClient.connect();
  await indexClient.connect();

  console.log('=== Step 1: Loading 150 Benchmark Documents ===');
  const docIds = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmarkDocs.json'), 'utf8'));

  const docsRes = await sourceClient.query(`
    SELECT document_id, source_type, original_record_id, title, question_context,
           display_text, author, language, record_date, multimedia_filename
    FROM public.corpus_documents
    WHERE document_id = ANY($1::text[])
  `, [docIds]);
  const docs = docsRes.rows;
  console.log(`Loaded ${docs.length} documents from universal_qa_source.`);

  // Clean benchmark tables
  await indexClient.query(`TRUNCATE semantic_qa_bench.passages_bgem3 CASCADE;`);
  await indexClient.query(`TRUNCATE semantic_qa_bench.passages_gemma CASCADE;`);
  await indexClient.query(`TRUNCATE semantic_qa_bench.answer_units CASCADE;`);
  await indexClient.query(`TRUNCATE semantic_qa_bench.documents CASCADE;`);

  // Insert into semantic_qa_bench.documents
  for (const doc of docs) {
    await indexClient.query(`
      INSERT INTO semantic_qa_bench.documents
      (document_id, source_type, original_record_id, title, question_context, display_text, author, language, record_date, multimedia_filename)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      doc.document_id, doc.source_type, doc.original_record_id, doc.title,
      doc.question_context, doc.display_text, doc.author, doc.language,
      doc.record_date, doc.multimedia_filename,
    ]);
  }
  console.log('Inserted documents into semantic_qa_bench.documents.');

  console.log('\n=== Step 2: Smart Segmentation & Offset Verification ===');
  const allAnswerUnits = [];
  const allPassages = [];

  let recoveredBhagavatGitaUnits = 0;

  for (const doc of docs) {
    const parsed = parseAnswerUnits(doc);
    if (doc.title.includes('Bhagavat Gita') && parsed.units.length > 0) {
      recoveredBhagavatGitaUnits += parsed.units.length;
    }

    let docPassageIndex = 0;
    for (const unit of parsed.units) {
      allAnswerUnits.push(unit);
      const unitPassages = segmentAnswerUnit(unit, doc.display_text, { minTarget: 250, maxTarget: 800 });

      for (const p of unitPassages) {
        // Offset verification
        const sliced = doc.display_text.slice(p.startOffset, p.endOffset).trim();
        if (sliced !== p.text) {
          throw new Error(`Offset mismatch in ${doc.document_id}! Expected: "${p.text.slice(0, 30)}...", got: "${sliced.slice(0, 30)}..."`);
        }

        allPassages.push({
          ...p,
          docTitle: doc.title,
          passageIndex: docPassageIndex,
          passageId: `${p.sourceId}:${docPassageIndex}`,
        });
        docPassageIndex += 1;
      }
    }
  }

  console.log(`Generated ${allAnswerUnits.length} answer units across 150 documents.`);
  console.log(`Recovered Bhagavat Gita units: ${recoveredBhagavatGitaUnits} (previously 0 in production index!).`);
  console.log(`Generated ${allPassages.length} smart passages (mean ~${Math.round(allPassages.reduce((s, p) => s + p.charLength, 0) / allPassages.length)} chars).`);

  // Compute length distribution
  const under20 = allPassages.filter(p => p.charLength <= 20).length;
  const under50 = allPassages.filter(p => p.charLength <= 50).length;
  const under100 = allPassages.filter(p => p.charLength <= 100).length;
  const between300and800 = allPassages.filter(p => p.charLength >= 300 && p.charLength <= 800).length;
  console.log('Smart Passages Length Distribution:');
  console.log(`  <= 20 chars: ${under20} (was ~3% in prod)`);
  console.log(`  <= 50 chars: ${under50} (was ~23% in prod)`);
  console.log(`  <= 100 chars: ${under100} (was ~49% in prod)`);
  console.log(`  300 - 800 chars (Ideal): ${between300and800} (${Math.round(between300and800 * 100 / allPassages.length)}%)`);

  // Insert answer units
  for (const u of allAnswerUnits) {
    await indexClient.query(`
      INSERT INTO semantic_qa_bench.answer_units
      (answer_unit_id, source_id, unit_index, unit_kind, author, associated_question, language, start_offset, end_offset, unit_text, content_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      u.answerUnitId, u.sourceId, u.unitIndex, u.unitKind, u.author,
      u.associatedQuestion, u.language, u.start, u.end, u.text, u.contentHash,
    ]);
  }
  console.log('Saved answer units to database.');

  console.log('\n=== Step 3: Embedding with EmbeddingGemma (768d, Context-Injected) ===');
  const startTimeGemma = Date.now();
  const BATCH_SIZE = 32;

  for (let i = 0; i < allPassages.length; i += BATCH_SIZE) {
    const batch = allPassages.slice(i, i + BATCH_SIZE);
    const contextualTexts = batch.map(p => buildContextualEmbeddingText(p, p.docTitle, 'embeddinggemma'));
    const vectors = await fetchEmbeddingBatch('embeddinggemma', contextualTexts);

    for (let j = 0; j < batch.length; j++) {
      const p = batch[j];
      const vecLiteral = toVectorLiteral(vectors[j]);
      await indexClient.query(`
        INSERT INTO semantic_qa_bench.passages_gemma
        (passage_id, source_id, passage_index, answer_unit_id, passage_text, char_length, start_offset, end_offset, unit_kind, associated_question, context_text, embedding)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)
      `, [
        p.passageId, p.sourceId, p.passageIndex, p.answerUnitId, p.text,
        p.charLength, p.startOffset, p.endOffset, p.unitKind, p.associatedQuestion,
        contextualTexts[j], vecLiteral,
      ]);
    }
    process.stdout.write(`Embedded Gemma: ${Math.min(i + BATCH_SIZE, allPassages.length)} / ${allPassages.length}\r`);
  }
  const gemmaDuration = ((Date.now() - startTimeGemma) / 1000).toFixed(1);
  console.log(`\nFinished EmbeddingGemma in ${gemmaDuration}s (${(allPassages.length / gemmaDuration).toFixed(1)} passages/sec).`);

  console.log('\n=== Step 4: Embedding with BGE-M3 (1024d, Multilingual Dense) ===');
  const startTimeBge = Date.now();

  for (let i = 0; i < allPassages.length; i += BATCH_SIZE) {
    const batch = allPassages.slice(i, i + BATCH_SIZE);
    const contextualTexts = batch.map(p => buildContextualEmbeddingText(p, p.docTitle, 'bge-m3'));
    const vectors = await fetchEmbeddingBatch('bge-m3', contextualTexts);

    for (let j = 0; j < batch.length; j++) {
      const p = batch[j];
      const vecLiteral = toVectorLiteral(vectors[j]);
      await indexClient.query(`
        INSERT INTO semantic_qa_bench.passages_bgem3
        (passage_id, source_id, passage_index, answer_unit_id, passage_text, char_length, start_offset, end_offset, unit_kind, associated_question, context_text, embedding)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)
      `, [
        p.passageId, p.sourceId, p.passageIndex, p.answerUnitId, p.text,
        p.charLength, p.startOffset, p.endOffset, p.unitKind, p.associatedQuestion,
        contextualTexts[j], vecLiteral,
      ]);
    }
    process.stdout.write(`Embedded BGE-M3: ${Math.min(i + BATCH_SIZE, allPassages.length)} / ${allPassages.length}\r`);
  }
  const bgeDuration = ((Date.now() - startTimeBge) / 1000).toFixed(1);
  console.log(`\nFinished BGE-M3 in ${bgeDuration}s (${(allPassages.length / bgeDuration).toFixed(1)} passages/sec).`);

  // Write stats summary
  const summary = {
    docCount: docs.length,
    answerUnitCount: allAnswerUnits.length,
    passageCount: allPassages.length,
    under20,
    under50,
    under100,
    between300and800,
    gemmaDurationSec: Number(gemmaDuration),
    bgeDurationSec: Number(bgeDuration),
  };
  fs.writeFileSync(path.join(__dirname, 'benchmarkStats.json'), JSON.stringify(summary, null, 2));

  await sourceClient.end();
  await indexClient.end();
  console.log('\n=== Benchmark Dataset & Index Creation Complete! ===');
}

run().catch(console.error);
