// A bounded additive channel: existing answer candidates keep every slot.
// Title rows must already have passed the single-answer-unit provenance query.
function addSingleUnitTitles(baseline, titleRows, {queryWords, idfMap, normalizeTitle, isGeneric, maxExtra=12}) {
  const key=row=>`${row.source_id}\u0000${row.matched_answer_unit_id||'record'}`;
  const existing=new Set(baseline.map(key));
  const query=new Set(queryWords.filter(w=>w&&!isGeneric(w)));
  if(!query.size)return [...baseline];
  const weight=w=>Math.max(.2,Number(idfMap[w])||1);
  const queryWeight=[...query].reduce((s,w)=>s+weight(w),0);
  const additions=titleRows.filter(r=>r.single_unit_title_candidate&&r.matched_answer_unit_id&&!existing.has(key(r))).flatMap((row,index)=>{
    const title=new Set(normalizeTitle(row.question||'').split(/\s+/u).filter(w=>w&&!isGeneric(w)));
    const hits=[...query].filter(w=>title.has(w));
    const hitWeight=hits.reduce((s,w)=>s+weight(w),0);
    const titleWeight=[...title].reduce((s,w)=>s+weight(w),0);
    const queryCoverage=hitWeight/queryWeight,titleCoverage=titleWeight?hitWeight/titleWeight:0;
    // Common one-word overlaps cannot introduce a new answer. A genuinely
    // single-word query may match its sole sufficiently specific word.
    if(hits.length<2&&!(query.size===1&&hits.length===1&&hits[0].length>=6))return [];
    if(queryCoverage<.55||titleCoverage<.35)return [];
    const relevance=2*queryCoverage*titleCoverage/(queryCoverage+titleCoverage);
    return [{row:{...row,record_retrieval_rank:index+1},relevance,index}];
  }).sort((a,b)=>b.relevance-a.relevance||a.index-b.index||key(a.row).localeCompare(key(b.row)));
  const result=[...baseline];
  for(const {row} of additions){if(existing.has(key(row)))continue;existing.add(key(row));result.push(row);if(result.length>=baseline.length+maxExtra)break;}
  return result;
}
async function retrieveSingleUnitTitles(pool, query) {
  if(!String(query||'').trim())return [];
  // Query the literal surface as well as the existing canonical channels. A
  // rare name must not disappear just because it maps to a common concept.
  // The records.question trigram GIN index supports this bounded query.
  const result=await pool.query(`
    SELECT r.source_id,r.question,''::text AS answer,r.metadata,r.content_hash,
      u.associated_question AS matched_discovery_text,
      u.answer_unit_id AS matched_answer_unit_id,u.unit_text AS matched_answer_unit_text,
      u.start_offset AS matched_answer_unit_start,u.content_hash AS matched_answer_unit_hash,
      true AS single_unit_title_candidate
    FROM semantic_qa.records r JOIN semantic_qa.answer_units u USING(source_id)
    WHERE r.question % $1
      AND coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
      AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
        THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END
      AND u.language='ENG' AND u.context_complete=true
      AND NOT EXISTS (SELECT 1 FROM semantic_qa.answer_units v
        WHERE v.source_id=u.source_id AND v.answer_unit_id<>u.answer_unit_id)
    ORDER BY similarity(r.question,$1) DESC,r.source_id LIMIT 30
  `,[query]);
  return result.rows;
}
module.exports={addSingleUnitTitles,retrieveSingleUnitTitles};
