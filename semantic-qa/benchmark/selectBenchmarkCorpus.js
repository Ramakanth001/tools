const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');

const cases = require('../eval/relevance-cases.json');

async function selectCorpus() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_source' });
  await client.connect();

  console.log('--- Selecting 150 Representative Documents ---');

  // 1. Ground truth documents from eval/relevance-cases.json
  const groundTruthGroups = [...new Set(cases.flatMap(c => c.relevantSourceGroups || []))];
  console.log(`Found ${groundTruthGroups.length} ground truth documents in relevance-cases.json`);

  // Verify which ones exist in corpus_documents
  const gtRes = await client.query(`
    SELECT document_id, source_type, title, language, length(display_text) as len
    FROM public.corpus_documents
    WHERE document_id = ANY($1::text[])
  `, [groundTruthGroups]);
  const selectedDocs = new Map(gtRes.rows.map(r => [r.document_id, r]));
  console.log(`Loaded ${selectedDocs.size} ground truth documents.`);

  // 2. 15 Shri Dattaguru Bhagavat Gita chapters (including previously ambiguous ones)
  const gitaRes = await client.query(`
    SELECT document_id, source_type, title, language, length(display_text) as len
    FROM public.corpus_documents
    WHERE title ILIKE '%Bhagavat Gita%' OR title ILIKE '%Brahma Khanda%' OR title ILIKE '%Vishnu Khanda%' OR title ILIKE '%Shiva Khanda%'
    ORDER BY document_id
    LIMIT 20
  `);
  for (const row of gitaRes.rows) {
    if (selectedDocs.size < 75 && !selectedDocs.has(row.document_id)) {
      selectedDocs.set(row.document_id, row);
    }
  }
  console.log(`Total after Bhagavat Gita: ${selectedDocs.size}`);

  // 3. 10 Telugu discourses
  const telRes = await client.query(`
    SELECT document_id, source_type, title, language, length(display_text) as len
    FROM public.corpus_documents
    WHERE language = 'TEL'
    ORDER BY document_id
    LIMIT 15
  `);
  for (const row of telRes.rows) {
    if (!selectedDocs.has(row.document_id)) {
      selectedDocs.set(row.document_id, row);
      if ([...selectedDocs.values()].filter(d => d.language === 'TEL').length >= 10) break;
    }
  }
  console.log(`Total after Telugu: ${selectedDocs.size}`);

  // 4. 10 Malayalam discourses
  const mamRes = await client.query(`
    SELECT document_id, source_type, title, language, length(display_text) as len
    FROM public.corpus_documents
    WHERE language = 'MAM'
    ORDER BY document_id
    LIMIT 15
  `);
  for (const row of mamRes.rows) {
    if (!selectedDocs.has(row.document_id)) {
      selectedDocs.set(row.document_id, row);
      if ([...selectedDocs.values()].filter(d => d.language === 'MAM').length >= 10) break;
    }
  }
  console.log(`Total after Malayalam: ${selectedDocs.size}`);

  // 5. 15 Q&A records
  const qaRes = await client.query(`
    SELECT document_id, source_type, title, language, length(display_text) as len
    FROM public.corpus_documents
    WHERE source_type = 'qa'
    ORDER BY document_id
    LIMIT 30
  `);
  for (const row of qaRes.rows) {
    if (!selectedDocs.has(row.document_id)) {
      selectedDocs.set(row.document_id, row);
      if ([...selectedDocs.values()].filter(d => d.source_type === 'qa').length >= 15) break;
    }
  }
  console.log(`Total after Q&A: ${selectedDocs.size}`);

  // 6. Fill up to 150 with diverse English discourses (varying lengths)
  const remainingNeeded = 150 - selectedDocs.size;
  if (remainingNeeded > 0) {
    const fillRes = await client.query(`
      SELECT document_id, source_type, title, language, length(display_text) as len
      FROM public.corpus_documents
      WHERE language = 'ENG' AND source_type = 'discourse'
        AND document_id != ALL($1::text[])
      ORDER BY original_record_id
      LIMIT $2
    `, [[...selectedDocs.keys()], remainingNeeded]);
    for (const row of fillRes.rows) {
      selectedDocs.set(row.document_id, row);
    }
  }

  const finalDocs = [...selectedDocs.values()];
  console.log(`\nFinal Selected Benchmark Corpus: ${finalDocs.length} documents`);

  const langSummary = {};
  const typeSummary = {};
  for (const d of finalDocs) {
    langSummary[d.language] = (langSummary[d.language] || 0) + 1;
    typeSummary[d.source_type] = (typeSummary[d.source_type] || 0) + 1;
  }
  console.log('Language Breakdown:', langSummary);
  console.log('Source Type Breakdown:', typeSummary);

  const outPath = path.join(__dirname, 'benchmarkDocs.json');
  fs.writeFileSync(outPath, JSON.stringify(finalDocs.map(d => d.document_id), null, 2));
  console.log(`Saved document IDs to ${outPath}`);

  await client.end();
}

selectCorpus().catch(console.error);
