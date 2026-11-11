const fs = require('fs');
const path = require('path');
const { parseAnswerUnits, segmentAnswerUnit, buildContextualEmbeddingText } = require('./smartSegmenter');
const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');

async function check() {
  const c = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_source' });
  await c.connect();
  const docIds = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmarkDocs.json'), 'utf8'));
  const docsRes = await c.query('SELECT * FROM public.corpus_documents WHERE document_id = ANY($1)', [docIds]);
  const docs = docsRes.rows;
  
  const allPassages = [];
  for (const doc of docs) {
    const parsed = parseAnswerUnits(doc);
    let idx = 0;
    for (const unit of parsed.units) {
      const ps = segmentAnswerUnit(unit, doc.display_text, { minTarget: 250, maxTarget: 800 });
      for (const p of ps) {
        const textGemma = buildContextualEmbeddingText(p, doc.title, 'embeddinggemma');
        allPassages.push({
          docId: doc.document_id,
          passageIndex: idx,
          gemmaLen: textGemma.length,
          qLen: (p.associatedQuestion || '').length,
          textLen: p.text.length,
          preview: textGemma.slice(0, 80)
        });
        idx++;
      }
    }
  }
  console.log('Total passages:', allPassages.length);
  const oversized = allPassages.filter(p => p.gemmaLen > 3000);
  console.log('Passages with prompt > 3000 chars:', oversized.length);
  for (const o of oversized) {
    console.log(`Doc: ${o.docId}, PromptLen: ${o.gemmaLen}, QLen: ${o.qLen}, TextLen: ${o.textLen}`);
  }
  await c.end();
}
check().catch(console.error);
