const test = require('node:test');
const assert = require('node:assert/strict');
const { lexicalTerms, nearWeight, addEnglishPassageCandidates, retrieveEnglishPassageCandidates,
  prepareEnglishPassageSearch, relationParts } = require('../src/distanceEnglishPassages');

test('accent and named transliteration variants share a single passage concept', () => {
  const terms = lexicalTerms("'rukmiṇī':1 'rukminii':4 'raadhaa':7 'radha':9 'while':10 'question':11 'other':96", 90);
  assert.deepEqual(terms.get('rukmini'), [1, 4]);
  assert.deepEqual(terms.get('radha'), [7, 9]);
  assert.equal(terms.has('question'), false);
  assert.equal(terms.has('other'), false);
});

test('concept proximity counts repeated positions of one concept once', () => {
  const nearby = [{ places: [7, 8, 9], weight: 3 }, { places: [16], weight: 4 }, { places: [103], weight: 3 }];
  assert.equal(nearWeight(nearby, 10), 0.7);
  assert.equal(nearWeight(nearby.slice(0, 1), 10), 0);
  assert.equal(nearWeight([nearby[0], nearby[2]], 6), 0);
});

test('sentence-local evidence cannot combine terms from different sentences', () => {
  const nearby = [{ places: [7], weight: 3 }, { places: [13, 22], weight: 4 }];
  assert.equal(nearWeight(nearby, 10, 24), 0.7);
  assert.equal(nearWeight(nearby, 10, 24, [10]), 0);
  assert.equal(nearWeight(nearby.concat({ places: [21], weight: 3 }), 10, 24, [10]), 0.7);
});

test('a question with ordinary English vocabulary reaches the matching answer sentence', async () => {
  const records = [
    { answer_unit_id: 'spread', content_hash: 'spread-text', record_hash: 'spread-record', document_length: 140,
      passage_terms: "'examin':4 'week':9 'distsentenceboundaryx':7" },
    { answer_unit_id: 'same', content_hash: 'same-text', record_hash: 'same-record', document_length: 140,
      passage_terms: "'examin':4 'week':9 'distsentenceboundaryx':13" },
    ...Array.from({ length: 6 }, (_, i) => ({ answer_unit_id: 'other-' + i, document_length: 140, passage_terms: "'other':1" })),
  ];
  let queries = 0;
  const pool = { async query(sql) {
    if (sql.includes('AS passage_terms')) {
      assert.match(sql, /distsentenceboundaryx/u);
      return { rows: records };
    }
    if (sql.includes('WITH ORDINALITY')) {
      queries++;
      return { rows: [{ vector: "'exam':4 'week':6" }] };
    }
    return { rows: records.slice(0, 2).map(row => ({ matched_answer_unit_id: row.answer_unit_id,
      content_hash: row.record_hash, matched_answer_unit_hash: row.content_hash,
      matched_answer_unit_text: 'Examinations start next week.' })) };
  } };
  const query = 'Should I study for the exam next week?';
  const evidence = await prepareEnglishPassageSearch(pool, query, query, { grounded: true });
  assert.ok(evidence);
  const found = await retrieveEnglishPassageCandidates(pool, query, query, 90, evidence);
  assert.deepEqual(found.map(row => row.matched_answer_unit_id), ['same', 'spread']);
  assert.equal(queries, 1);
});

test('an exact mixed letter-and-digit identifier skips relaxed passage matching', async () => {
  const pool = { query() { assert.fail('Do not expand a model or catalogue identifier into loose topic words'); } };
  assert.equal(await prepareEnglishPassageSearch(pool, 'What preparation is required for test cycle VX-240?', '', { grounded: true }), null);
});

test('ordinary queries do not activate expansion when their rare terms only match disjoint sentences', async () => {
  const unrelated = Array.from({ length: 6 }, (_, i) => ({ answer_unit_id: 'other-' + i, document_length: 100 }));
  const pool = { async query(sql) {
    if (sql.includes('AS passage_terms')) return { rows: [
      { answer_unit_id: 'spread', document_length: 140,
        passage_terms: "'calibr':4 'thermom':9 'distsentenceboundaryx':7" },
      ...unrelated,
    ] };
    if (sql.includes('WITH ORDINALITY')) return { rows: [{ vector: "'calibr':4 'thermom':6" }] };
    return { rows: [] };
  } };
  const query = 'How do I calibrate the thermometer?';
  assert.equal(await prepareEnglishPassageSearch(pool, query, query, { grounded: true }), null);
});

test('passage matching keeps devotion and Nivritti distinct', () => {
  const terms = lexicalTerms("'devot':1 'bhakti':4 'nivṛtti':7");
  assert.deepEqual(terms.get('bhakti'), [1, 4]);
  assert.deepEqual(terms.get('nivritti'), [7]);
});

test('comparison wording exposes the two sides of the requested relationship', () => {
  assert.deepEqual(relationParts('How does Swami distinguish attachment to God from attachment to possessions?'),
    ['attachment to God', 'attachment to possessions?']);
  assert.deepEqual(relationParts('Which comes first, trust in God or detachment from possessions?'),
    ['trust in God', 'detachment from possessions?']);
  assert.deepEqual(relationParts('What does Swami say about attachment?'), []);
});

test('passage evidence is merged only for the same unchanged answer and source', () => {
  const answer = { source_id: 'source', content_hash: 'source-v1', matched_answer_unit_id: 'id', matched_answer_unit_hash: 'answer-v1' };
  const ranked = { ...answer, english_passage_evidence: { verified: true, strength: 0.7 } };
  const [merged] = addEnglishPassageCandidates([answer], [ranked], 900000);
  assert.deepEqual(merged, { ...ranked, english_passage_weight: 900000 });
  const mismatch = { ...answer, content_hash: 'source-v2' };
  assert.deepEqual(addEnglishPassageCandidates([mismatch], [ranked], 900000), [mismatch]);
});

test('raw query evidence survives an unproductive repair and stale citations are rejected', async () => {
  const corpus = [
    { answer_unit_id: 'current', content_hash: 'expected', record_hash: 'record', document_length: 300,
      passage_terms: "'miracl':1 'knowledge':3" },
    { answer_unit_id: 'stale', content_hash: 'old', record_hash: 'record', document_length: 330,
      passage_terms: "'miracl':1 'knowledge':3" },
    ...Array.from({ length: 5 }, (_, i) => ({ answer_unit_id: `other-${i}`, document_length: 100, passage_terms: "'else':1" })),
  ];
  const pool = { async query(sql, params) {
    if (sql.includes('AS passage_terms')) return { rows: corpus };
    if (sql.includes('WITH ORDINALITY')) {
      assert.deepEqual(params[0].slice(0, 2), ['Why are miracles linked to knowledge?', 'changed query']);
      return { rows: [{ vector: "'miracl':1 'knowledge':3" }, { vector: "'changed':1" }] };
    }
    return { rows: [
      { matched_answer_unit_id: 'current', content_hash: 'record', matched_answer_unit_hash: 'expected', matched_answer_unit_text: 'Because miracles can be linked to knowledge.' },
      { matched_answer_unit_id: 'stale', content_hash: 'record', matched_answer_unit_hash: 'new', matched_answer_unit_text: 'Stale' },
    ] };
  } };
  const passages = await retrieveEnglishPassageCandidates(pool, 'Why are miracles linked to knowledge?', 'changed query');
  assert.deepEqual(passages.map(row => row.matched_answer_unit_id), ['current']);
  assert.equal(passages[0].english_passage_evidence.verified, true);
});
