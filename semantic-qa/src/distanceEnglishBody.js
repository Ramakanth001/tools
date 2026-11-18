// English lexical retrieval only: PostgreSQL stemming and corpus frequencies.
// No embeddings, language model, external service or MySQL connection.
const { createDistanceCorpusCache } = require('./distanceCorpusCache');
let lexicon=null,lexiconPromise=null,expiresAt=0;
const corpusIndex = createDistanceCorpusCache(buildCorpusIndex);
const STOP=new Set('according address addresses argument arguments ask asks asked based clarification clarify compare compared describe describes description distinguish distinguishes explain explains explanation explanations give gives given how meaning meanings please point points question questions say says said show shows shown spiritual spirituality swami swamiji teaching teachings tell tells this what whether which why'.split(' '));
for(const word of 'also account accounts clarify clarified comparing comparison contrast contrasts contrasted contrasting correlate correlates correlation defend defends despite differ differs difference differences distinguish distinguished distinguishing emphasize emphasizes emphasizing english instead interpret interpretation interpretations interpretative prioritize prioritizes priority rather reason reasons reconcile reconciles reconciled reconciling reconciliation recommend recommends recommendation recommendations regarding relate related relates relation relationship understand understanding understood whereas'.split(' '))STOP.add(word);
async function ensureEnglishBodyIndex(client){
  await client.query(`CREATE OR REPLACE FUNCTION semantic_qa.distance_english_tf_v1(v tsvector)
    RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
      SELECT coalesce(jsonb_object_agg(x.lexeme,cardinality(x.positions)),'{}'::jsonb) FROM unnest(v) x
    $fn$`);
  await client.query(`ALTER TABLE semantic_qa.answer_units ADD COLUMN IF NOT EXISTS distance_english_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,unit_text)) STORED`);
  await client.query(`ALTER TABLE semantic_qa.answer_units ADD COLUMN IF NOT EXISTS distance_english_context_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,associated_question)) STORED`);
  await client.query(`ALTER TABLE semantic_qa.records ADD COLUMN IF NOT EXISTS distance_english_title_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,question)) STORED`);
  await client.query(`ALTER TABLE semantic_qa.answer_units ADD COLUMN IF NOT EXISTS distance_english_frequencies jsonb GENERATED ALWAYS AS
    (semantic_qa.distance_english_tf_v1(to_tsvector('english'::regconfig,unit_text)||to_tsvector('english'::regconfig,associated_question))) STORED`);
  await client.query(`ALTER TABLE semantic_qa.records ADD COLUMN IF NOT EXISTS distance_english_title_frequencies jsonb GENERATED ALWAYS AS
    (semantic_qa.distance_english_tf_v1(to_tsvector('english'::regconfig,question))) STORED`);
  await client.query(`CREATE INDEX IF NOT EXISTS semantic_qa_answer_units_distance_english_gin ON semantic_qa.answer_units USING gin(distance_english_vector)`);
  await client.query(`CREATE INDEX IF NOT EXISTS semantic_qa_answer_units_distance_english_context_gin ON semantic_qa.answer_units USING gin(distance_english_context_vector)`);
  await client.query(`CREATE INDEX IF NOT EXISTS semantic_qa_records_distance_english_title_gin ON semantic_qa.records USING gin(distance_english_title_vector)`);
}
function clearEnglishBodyCache(){lexicon=null;lexiconPromise=null;expiresAt=0;corpusIndex.clear();}
async function getLexicon(pool){
  if(lexicon&&Date.now()<expiresAt)return lexicon;
  if(!lexiconPromise)lexiconPromise=(async()=>{
    const [words,count]=await Promise.all([
      pool.query(`SELECT word,ndoc FROM ts_stat('SELECT u.distance_english_vector || u.distance_english_context_vector || CASE WHEN NOT EXISTS (SELECT 1 FROM semantic_qa.answer_units v WHERE v.source_id=u.source_id AND v.answer_unit_id<>u.answer_unit_id) THEN r.distance_english_title_vector ELSE ''''::tsvector END FROM semantic_qa.answer_units u JOIN semantic_qa.records r USING(source_id) WHERE u.language=''ENG'' AND u.context_complete=true')`),
      pool.query(`SELECT count(*)::int AS n,avg(length(unit_text)) AS average_length FROM semantic_qa.answer_units WHERE language='ENG' AND context_complete=true`)
    ]);
    lexicon={documents:count.rows[0].n,averageLength:Number(count.rows[0].average_length)||1000,frequencies:new Map(words.rows.map(r=>[r.word,Number(r.ndoc)]))};expiresAt=Date.now()+300000;return lexicon;
  })().finally(()=>{lexiconPromise=null;});
  return lexiconPromise;
}
function selectBodyTerms(stems,inventory,{maxTerms=12}={}){
  return [...new Set(stems)].filter(w=>/^[\p{L}\p{M}]{3,}$/u.test(w)&&!STOP.has(w)&&!STOP.has(w+'s'))
    .map(term=>({term,documents:inventory.frequencies.get(term)||0}))
    .filter(t=>t.documents>0&&t.documents<=inventory.documents*.60)
    .map(t=>({...t,weight:Math.log(1+(inventory.documents-t.documents+.5)/(t.documents+.5))}))
    .sort((a,b)=>a.documents-b.documents||a.term.localeCompare(b.term)).slice(0,maxTerms);
}

const ordinalNumbers = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth',
];

function numberedTitleReference(query) {
  const text = String(query || '').trim();
  if (/^(?:what|who|why|when|where|how|which|can|does|please)\b/iu.test(text)) return null;
  const match = text.match(/^(.+?)[\s:–-]+(chapter|verse|part|volume|section|sutra|sūtra)[\s:–-]+(\d+)(?:\s*[?.!])?$/iu);
  if (!match || !/^[\p{L}\p{M}.'’: -]{1,100}$/u.test(match[1])) return null;
  return { name: match[1], kind: match[2].toLowerCase(), number: Number(match[3]) };
}

function isNumberedReferenceLookup(query) {
  return Boolean(numberedTitleReference(query)
    || /^[\p{L}\p{M} .’'-]{1,100}\s+\d+:\d+(?:[–-]\d+)?\s*[?.!]?$/u.test(String(query || '').trim()));
}

function questionReference(query) {
  const ordinal = ordinalNumbers.join('|');
  const match = String(query || '').match(new RegExp(
    `\\b(${ordinal}|\\d+(?:st|nd|rd|th))\\s+(verse|chapter|section|part)\\s+of\\s+(.+?)(?=\\s+(?:say|says|ask|asks|teach|teaches|explain|explains|describe|describes|discuss|discusses|mean|means)\\b|[?!.]?$)`,
    'iu',
  ));
  if (!match) return null;
  const ordinalIndex = ordinalNumbers.indexOf(match[1].toLowerCase());
  return { name: match[3], kind: match[2].toLowerCase(), number: ordinalIndex >= 0 ? ordinalIndex + 1 : Number.parseInt(match[1], 10) };
}

function matchesQuestionReference(reference, candidateTitle, normalize) {
  if (!reference) return false;
  const title = numberedTitleReference(candidateTitle);
  return Boolean(title && title.kind === reference.kind && title.number === reference.number
    && normalize(title.name) === normalize(reference.name));
}
async function retrieveEnglishBodyCandidatesSql(pool,query,{limit=60}={}){
  const inventory=await getLexicon(pool);
  const substantive=String(query||'').match(/[\p{L}\p{M}\p{N}]+/gu)?.filter(w=>!STOP.has(w.toLowerCase())).join(' ')||'';
  const parsed=await pool.query(`SELECT tsvector_to_array(to_tsvector('english'::regconfig,$1)) AS terms`,[substantive]);
  const terms=selectBodyTerms(parsed.rows[0]?.terms||[],inventory);
  if(terms.length<2)return {rows:[],terms};
  const total=terms.reduce((s,t)=>s+t.weight,0);
  const result=await pool.query(`
    WITH terms AS MATERIALIZED (
      SELECT term,weight,to_tsquery('simple',term) AS q
      FROM unnest($1::text[],$2::double precision[]) AS t(term,weight)
    ), hits AS MATERIALIZED (
      SELECT u.answer_unit_id FROM semantic_qa.answer_units u
      WHERE u.language='ENG' AND u.context_complete=true
        AND (u.distance_english_vector @@ to_tsquery('simple',$3)
          OR u.distance_english_context_vector @@ to_tsquery('simple',$3))
      UNION
      SELECT u.answer_unit_id FROM semantic_qa.records r JOIN semantic_qa.answer_units u USING(source_id)
      WHERE r.distance_english_title_vector @@ to_tsquery('simple',$3)
        AND u.language='ENG' AND u.context_complete=true
        AND NOT EXISTS(SELECT 1 FROM semantic_qa.answer_units v WHERE v.source_id=u.source_id AND v.answer_unit_id<>u.answer_unit_id)
    ), candidates AS MATERIALIZED (
      SELECT u.answer_unit_id,u.source_id,length(u.unit_text) AS document_length,u.distance_english_frequencies,
        CASE WHEN NOT EXISTS(SELECT 1 FROM semantic_qa.answer_units v WHERE v.source_id=u.source_id AND v.answer_unit_id<>u.answer_unit_id)
          THEN r.distance_english_title_frequencies ELSE '{}'::jsonb END AS title_frequencies
      FROM hits h JOIN semantic_qa.answer_units u USING(answer_unit_id)
      JOIN semantic_qa.records r USING(source_id)
      WHERE u.language='ENG' AND u.context_complete=true
        AND coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
        AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
          THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END
    ), scored AS (
      SELECT c.answer_unit_id,c.source_id,e.matched_weight,e.matched_terms,e.bm25_score
      FROM candidates c CROSS JOIN LATERAL (
        SELECT coalesce(sum(t.weight),0) AS matched_weight,array_agg(t.term) AS matched_terms,
          sum(t.weight * (f.frequency*2.2) /
            (f.frequency+1.2*(0.25+0.75*c.document_length/$6::double precision))) AS bm25_score
        FROM terms t CROSS JOIN LATERAL (
          SELECT least(256,coalesce((c.distance_english_frequencies->>t.term)::int,0)+coalesce((c.title_frequencies->>t.term)::int,0)) AS frequency OFFSET 0
        ) f WHERE f.frequency>0
      ) e
      WHERE cardinality(e.matched_terms)>=2
    ), ranked AS MATERIALIZED (
      SELECT * FROM scored WHERE matched_weight/$4::double precision>=0.25
      ORDER BY bm25_score DESC,source_id,answer_unit_id LIMIT $5
    )
    SELECT u.source_id,r.question,''::text AS answer,r.metadata,r.content_hash,
      u.associated_question AS matched_discovery_text,u.answer_unit_id AS matched_answer_unit_id,
      u.unit_text AS matched_answer_unit_text,u.start_offset AS matched_answer_unit_start,
      u.content_hash AS matched_answer_unit_hash,ranked.matched_terms AS english_body_matched_terms,
      ranked.matched_weight/$4::double precision AS english_body_coverage,
      ranked.bm25_score AS english_body_rank_score
    FROM ranked JOIN semantic_qa.answer_units u USING(answer_unit_id)
    JOIN semantic_qa.records r ON r.source_id=u.source_id
    ORDER BY ranked.bm25_score DESC,u.source_id,u.answer_unit_id
  `,[terms.map(t=>t.term),terms.map(t=>t.weight),terms.map(t=>t.term).join(' | '),total,Math.max(1,Math.min(200,limit)),inventory.averageLength]);
  for(const row of result.rows)row.english_body_matched_terms?.sort();
  return {rows:result.rows,terms};
}

async function buildCorpusIndex(pool) {
  const { rows } = await pool.query(`
    SELECT u.answer_unit_id, u.content_hash, r.content_hash AS record_hash, length(u.unit_text) AS document_length,
           u.distance_english_frequencies AS terms,
           CASE WHEN NOT EXISTS (
             SELECT 1 FROM semantic_qa.answer_units v
             WHERE v.source_id=u.source_id AND v.answer_unit_id<>u.answer_unit_id
           ) THEN r.distance_english_title_frequencies END AS title_terms,
           coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
             AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
               THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END AS eligible
    FROM semantic_qa.answer_units u JOIN semantic_qa.records r USING(source_id)
    WHERE u.language='ENG' AND u.context_complete=true
    ORDER BY u.source_id,u.answer_unit_id
  `);
  const averageLength = rows.reduce((sum, row) => sum + row.document_length, 0) / Math.max(1, rows.length) || 1000;
  const postings = new Map();
  const lengths = new Float64Array(rows.length);
  const documents = rows.map((row, index) => {
    lengths[index] = 1.2 * (0.25 + 0.75 * row.document_length / averageLength);
    const terms = new Map(Object.entries(row.terms || {}));
    for (const [term, count] of Object.entries(row.title_terms || {})) {
      terms.set(term, Math.min(256, (terms.get(term) || 0) + count));
    }
    for (const [term, count] of terms) {
      let posting = postings.get(term);
      if (!posting) postings.set(term, posting = { documents: 0, entries: [] });
      posting.documents++;
      if (row.eligible) posting.entries.push(index, count);
    }
    return { id: row.answer_unit_id, hash: row.content_hash, recordHash: row.record_hash };
  });
  const frequencies = new Map();
  for (const [term, posting] of postings) {
    frequencies.set(term, posting.documents);
    postings.set(term, Uint32Array.from(posting.entries));
  }
  return { documents: rows.length, identities: documents, frequencies, postings, lengths };
}

async function retrieveEnglishBodyCandidates(pool, query, { limit = 60, reference = false } = {}) {
  if (reference) return retrieveEnglishBodyCandidatesSql(pool, query, { limit });
  const substantive = String(query || '').match(/[\p{L}\p{M}\p{N}]+/gu)
    ?.filter(word => !STOP.has(word.toLowerCase())).join(' ') || '';
  const [index, parsed] = await Promise.all([
    corpusIndex.get(pool),
    pool.query(`SELECT tsvector_to_array(to_tsvector('english'::regconfig,$1)) AS terms`, [substantive]),
  ]);
  const terms = selectBodyTerms(parsed.rows[0]?.terms || [], index);
  if (terms.length < 2) return { rows: [], terms };
  const accumulators = new Map();
  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0);
  for (const { term, weight } of terms) {
    const entries = index.postings.get(term);
    for (let i = 0; i < entries.length; i += 2) {
      const document = entries[i];
      const frequency = entries[i + 1];
      let match = accumulators.get(document);
      if (!match) accumulators.set(document, match = { document, matched: [], weight: 0, score: 0 });
      match.matched.push(term);
      match.weight += weight;
      match.score += weight * (frequency * 2.2) / (frequency + index.lengths[document]);
    }
  }
  const ranked = [...accumulators.values()]
    .filter(match => match.matched.length >= 2 && match.weight / totalWeight >= 0.25)
    .sort((a, b) => b.score - a.score || a.document - b.document)
    .slice(0, Math.max(1, Math.min(200, limit)));
  if (!ranked.length) return { rows: [], terms };
  const ids = ranked.map(match => index.identities[match.document].id);
  const { rows } = await pool.query(`
    SELECT u.source_id,r.question,''::text AS answer,r.metadata,r.content_hash,
           u.associated_question AS matched_discovery_text,u.answer_unit_id AS matched_answer_unit_id,
           u.unit_text AS matched_answer_unit_text,u.start_offset AS matched_answer_unit_start,
           u.content_hash AS matched_answer_unit_hash,
           ARRAY(SELECT term FROM unnest($2::text[]) term
                 WHERE u.distance_english_context_vector @@ to_tsquery('simple',term)) AS question_terms
    FROM semantic_qa.answer_units u JOIN semantic_qa.records r USING(source_id)
    WHERE u.answer_unit_id=ANY($1::text[]) AND u.language='ENG' AND u.context_complete=true
      AND coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
      AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
        THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END
  `, [ids, terms.map(term => term.term)]);
  const weights = new Map(terms.map(term => [term.term, term.weight]));
  const byId = new Map(rows.map(row => [row.matched_answer_unit_id, row]));
  return {
    rows: ranked.flatMap(match => {
      const { id, hash, recordHash } = index.identities[match.document];
      const row = byId.get(id);
      if (!row || row.matched_answer_unit_hash !== hash || row.content_hash !== recordHash) return [];
      const questionCoverage = row.question_terms.length >= 2
        ? row.question_terms.reduce((sum, term) => sum + weights.get(term), 0) / totalWeight : 0;
      const { question_terms: _, ...passage } = row;
      return [{
        ...passage,
        english_body_matched_terms: match.matched.sort(),
        english_body_coverage: match.weight / totalWeight,
        english_body_rank_score: match.score,
        english_question_coverage: questionCoverage,
      }];
    }),
    terms,
  };
}
function addEnglishBodyCandidates(baseline,rows,{weight=450000,maxExtra=120}={}){
  const key=r=>`${r.source_id}\u0000${r.matched_answer_unit_id||'record'}`;
  const evidence=new Map(rows.map((row,i)=>[key(row),{
    english_body_coverage:row.english_body_coverage,
    english_body_rank_score:row.english_body_rank_score,
    english_body_matched_terms:row.english_body_matched_terms,
    english_body_retrieval_rank:i+1,
    english_body_weight:Math.max(0,Math.min(600000,weight)),
    english_question_coverage:row.english_question_coverage || 0,
  }]));
  const present=new Set(baseline.map(key));
  const result=baseline.map(row=>evidence.has(key(row))?{...row,...evidence.get(key(row))}:row);
  let added=0;
  for(const row of rows){if(present.has(key(row)))continue;if(added>=maxExtra)break;present.add(key(row));result.push({...row,...evidence.get(key(row))});added++;}
  return result;
}
function englishBodyBoost(row){
  const coverage=Math.max(0,Math.min(1,Number(row.english_body_coverage)||0));
  const rank=Number(row.english_body_retrieval_rank)||0;
  if(!rank||!row.english_body_matched_terms||row.english_body_matched_terms.length<2)return 0;
  const contextCoverage = Math.max(0, Math.min(1, Number(row.english_question_coverage) || 0));
  const body = coverage * coverage / (1 + (rank - 1) / 10);
  // Surface stems shared with the actual companion question are stronger
  // evidence than the same number of scattered terms in the answer alone.
  return (Number(row.english_body_weight)||0) * (body + 0.65 * contextCoverage * contextCoverage);
}
module.exports={ensureEnglishBodyIndex,clearEnglishBodyCache,selectBodyTerms,retrieveEnglishBodyCandidates,addEnglishBodyCandidates,englishBodyBoost,numberedTitleReference,isNumberedReferenceLookup,questionReference,matchesQuestionReference};
