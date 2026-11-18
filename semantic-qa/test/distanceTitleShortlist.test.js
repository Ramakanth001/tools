const test=require('node:test');
const assert=require('node:assert/strict');
const {addSingleUnitTitles}=require('../src/distanceTitleShortlist');
const options={queryWords:['practical','devotion'],idfMap:{practical:2,devotion:3},normalizeTitle:s=>s.toLowerCase(),isGeneric:w=>['what','is','and','the'].includes(w),maxExtra:2};
const row=(id,title='Practical devotion')=>({source_id:id,matched_answer_unit_id:id+':unit',question:title,single_unit_title_candidate:true});
test('title expansion preserves every original candidate and adds a bounded distinct answer set',()=>{
  const baseline=Array.from({length:105},(_,i)=>row(String(i)));
  const snapshot=structuredClone(baseline);
  const result=addSingleUnitTitles(baseline,[row('new1'),row('new2'),row('new3'),row('1')],options);
  assert.deepEqual(result.slice(0,105),baseline);
  assert.deepEqual(baseline,snapshot);
  assert.equal(result.length,107);
  assert.equal(new Set(result.map(r=>r.matched_answer_unit_id)).size,107);
});
test('common overlap and unverified record rows cannot introduce new answer units',()=>{
  const unverified={...row('unverified'),single_unit_title_candidate:false};
  const result=addSingleUnitTitles([],[row('weak','Devotion and unrelated'),unverified],options);
  assert.equal(result.length,0);
});
test('title allocation prefers coverage and specificity over record retrieval order',()=>{
  const result=addSingleUnitTitles([],[row('long','Practical devotion and unrelated material'),row('focused')],options);
  assert.equal(result[0].source_id,'focused');
});

test('extended interpretation framing is opt-in',()=>{
  const active=require('../src/distanceSearch');
  const question='How should the highest form of meditation be understood?';
  assert.equal(active.stripSearchFraming(question),question);
  assert.equal(active.stripSearchFraming(question,{extended:true}),'the highest form of meditation?');
});
