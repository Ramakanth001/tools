const test=require('node:test');
const assert=require('node:assert/strict');
const {selectBodyTerms,retrieveEnglishBodyCandidates}=require('../src/distanceEnglishBody');
const {addEnglishBodyCandidates,englishBodyBoost}=require('../src/distanceEnglishBody');
const {isNumberedReferenceLookup,questionReference,matchesQuestionReference}=require('../src/distanceEnglishBody');

test('numbered titles retain exact lookup while questions about their content use body search',()=>{
  assert.equal(isNumberedReferenceLookup('Dattamata Vimsahti: Verse 11?'),true);
  assert.equal(isNumberedReferenceLookup('Bhagavad Gita 2:47'),true);
  assert.equal(isNumberedReferenceLookup('Why does Krishna counsel action without attachment in verse 47?'),false);
  assert.equal(isNumberedReferenceLookup('What is the meaning of chapter 3?'),false);
});

test('only the named work, type and ordinal may receive explicit reference priority',()=>{
  const reference=questionReference('What does the first verse of Dattamata Vimshati ask God Datta to forgive?');
  const normalize=value=>value.toLowerCase().trim();
  assert.deepEqual(reference,{name:'Dattamata Vimshati',kind:'verse',number:1});
  assert.ok(matchesQuestionReference(reference,'Dattamata Vimshati: Verse 1',normalize));
  assert.ok(!matchesQuestionReference(reference,'Dattamata Vimshati: Verse 11',normalize));
  assert.ok(!matchesQuestionReference(reference,'Dattamata Vimshati: Part 1',normalize));
  assert.ok(!matchesQuestionReference(reference,'Bhagavad Gita: Verse 1',normalize));
  assert.equal(questionReference('Why is Krishna called Govinda?'),null);
});
test('English body terms use corpus frequency, ignore unknown technical terms and exclude common framing',()=>{
  const inventory={documents:1000,frequencies:new Map([['god',900],['swami',400],['teaching',200],['vegetarian',20],['food',100],['select',30]])};
  const terms=selectBodyTerms(['god','swami','teaching','vegetarian','food','select','quench'],inventory);
  assert.deepEqual(terms.map(t=>t.term),['vegetarian','select','food']);
  assert.ok(terms[0].weight>terms[2].weight);
});
test('English body query budget is deterministic, deduplicated and cannot inject tsquery operators',()=>{
  const inventory={documents:100,frequencies:new Map([['karma',3],['devotion',4],['service',5],['x | y',1]])};
  const terms=selectBodyTerms(['karma','karma','devotion','service','x | y'],inventory,{maxTerms:2});
  assert.deepEqual(terms.map(t=>t.term),['karma','devotion']);
});

test('English evidence preserves original citations and question context while bounding new units',()=>{
  const original={source_id:'s1',matched_answer_unit_id:'u1',matched_discovery_text:'Original stored question',matched_answer_unit_hash:'original-hash'};
  const rows=[1,2,3,4].map(i=>({source_id:'s'+i,matched_answer_unit_id:'u'+i,matched_discovery_text:'Other context',english_body_coverage:.8,english_body_matched_terms:['service','devotion'],english_body_rank_score:5}));
  const result=addEnglishBodyCandidates([original],rows,{maxExtra:2});
  assert.equal(result.length,3);
  assert.equal(result[0].matched_discovery_text,original.matched_discovery_text);
  assert.equal(result[0].matched_answer_unit_hash,'original-hash');
  assert.equal(result[0].english_body_retrieval_rank,1);
  assert.equal(new Set(result.map(r=>r.matched_answer_unit_id)).size,3);
  assert.equal(original.english_body_retrieval_rank,undefined);
});

test('English bonus requires multiple terms and diminishes with weaker coverage and lower rank',()=>{
  const row={english_body_weight:450000,english_body_coverage:1,english_body_retrieval_rank:1,english_body_matched_terms:['service','devotion']};
  assert.equal(englishBodyBoost({}),0);
  assert.equal(englishBodyBoost({...row,english_body_matched_terms:['service']}),0);
  assert.ok(englishBodyBoost(row)>englishBodyBoost({...row,english_body_coverage:.5}));
  assert.ok(englishBodyBoost(row)>englishBodyBoost({...row,english_body_retrieval_rank:10}));
});

test('an older PostgreSQL corpus can use English body retrieval before its next index refresh', async () => {
  const unit={answer_unit_id:'u1',content_hash:'unit-hash',record_hash:'record-hash',document_length:90,
    terms:{lesson:2,review:1},eligible:true};
  const pool={async query(sql) {
    if (sql.includes('AS answer_version')) return {rows:[{answer_version:'1',record_version:'1'}]};
    if (sql.includes('u.distance_english_frequencies')) throw Object.assign(new Error('Missing stored data'),{code:'42703'});
    if (sql.includes('AS document_length')) {
      assert.match(sql,/FROM unnest\(to_tsvector/u);
      return {rows:[unit,...Array.from({length:5},(_,i)=>({...unit,answer_unit_id:'other'+i,terms:{other:1}}))]};
    }
    if (sql.includes('tsvector_to_array')) return {rows:[{terms:['lesson','review']}]};
    assert.match(sql,/to_tsvector\('english'::regconfig,u.associated_question\) @@/u);
    return {rows:[{matched_answer_unit_id:'u1',matched_answer_unit_hash:'unit-hash',
      content_hash:'record-hash',question_terms:['lesson','review']}]};
  }};
  const result=await retrieveEnglishBodyCandidates(pool,'How should I review a lesson?');
  assert.deepEqual(result.rows.map(row=>row.matched_answer_unit_id),['u1']);
});
