const { getCanonicalSpiritualTerm } = require('./spiritualEquivalents');
const { createDistanceCorpusCache } = require('./distanceCorpusCache');

const FRAME = new Set(`accord act also anchor answer ask author base belief can
  case caus chang claim come compar concept condit consider contrast correct could
  describ differ direct discuss distinct distinguish doctri does
  even explain express feel form give good happen help how idea
  importanc includ instead interpret issu just know last lead main make mean
  mention might much must need next object observ occur oppos order part period
  place point practic present provid purpos question reason receiv recommend
  regard relat relationship remain repli respons role said say seek see set
  should show state step still suggest support swami teach tell tend term
  text thing think through topic toward treat true understand unit use value
  view way what when where whether which who why will without word would wrong
  though there discours reach require review`.split(/\s+/u));

// Additional aliases preserve the original query and share document frequency.
// Each entry contains English Snowball stems or transliterated proper names.
const ALIASES = [
  ['radha', 'raadha', 'raadhaa'], ['rukmini', 'rukminii'],
  ['brindavan', 'brindavanam', 'vrindavan', 'vrindavana'], ['samsar', 'samsare', 'samsaar', 'samsaare'],
  ['guru', 'sadguru'], ['staff', 'walkstick'], ['birthplac', 'birth-plac'],
  ['birthday', 'birthdat', 'birth-dat'], ['cowherd', 'cow-herd'], ['miracl', 'miracul'],
  ['bhakti', 'bhakthi', 'devot', 'devotion', 'devotional'],
  ['exam', 'examin'],
];
const ALIAS_KEY = new Map(ALIASES.flatMap(group => group.map(term => [term, group[0]])));
const TERM_PATTERN = /'((?:[^'\\]|''|\\.)+)'(?::([\dA-D,]+))?/gu;
const DOMAIN = /\b(?:swami(?:ji)?|miracles?|incarnations?|god|divine|spiritual|devot\w*|prayers?|sainthood|sins?|karma|scriptur\w*|krishna|datta|brahma|vishnu|rudra|shiva|rama|radha|jesus|muhammad|buddha|gita)\b/iu;
const QUESTION = /\b(?:what|who|why|where|which|how|when|whether|should|could|can|does|did|difference|explain|compare)\b/iu;
const SENTENCE_BOUNDARY = 'distsentenceboundaryx';
const SOURCE_IDENTIFIER = /\b(?:[a-z]{2,}-\d[a-z0-9-]*|(?=[a-z0-9]*[a-z][a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{4,})\b/giu;
const CAPITALIZED_WORD = /[\p{Lu}][\p{Ll}\p{M}]{3,}/gu;
const NON_LATIN_LETTER = /[^\P{L}\p{Script=Latin}]/u;

const INTENT = [
  { query: /\b(?:which comes first|what comes first|sequence|before|after)\b/iu, passage: /\b(?:first|before|after|prior to|followed by|then|next)\b/iu },
  { query: /\b(?:difference|differ|compare|contrast|distinguish|distinction|versus)\b/iu, passage: /\b(?:difference|different|whereas|while|unlike|both|on the other hand|but)\b/iu },
  { query: /\b(?:under what condition|in what circumstances|when|whether)\b/iu, passage: /\b(?:if|when|unless|only|condition|provided)\b/iu },
  { query: /\b(?:why|reason|cause)\b/iu, passage: /\b(?:because|reason|therefore|since|hence|so that|due to)\b/iu },
  { query: /\b(?:called|definition|define|meaning|mean)\b/iu, passage: /\b(?:is called|means|refers to|definition of|is known as)\b/iu },
  { query: /\b(?:where|what (?:text|source|scripture))\b/iu, passage: /\b(?:purana\w*|upanishad\w*|scripture\w*|section|verses?|chapter|book|gita|bible|quran)\b/iu },
];
const RELATIONS = [
  /\b(?:difference|distinction) between (.+?) and (.+)/iu,
  /\b(?:distinguish|contrast) (.+?) (?:from|with|versus) (.+)/iu,
  /\b(?:when|if) (.+?) and (?:when|if) (.+)/iu,
  /\b(?:what|which) comes first[, :] *(.*?) (?:or|versus) (.+)/iu,
  /\b(.+?) (?:instead of|rather than|as opposed to) (.+)/iu,
];

// Prepare plain English and transliterated words before PostgreSQL tokenization.
// Some punctuation and emoji in the source otherwise form non-word lexemes.
const wordVectorSql = column => `to_tsvector('english'::regconfig,
  regexp_replace(regexp_replace(normalize(${column}, NFKD), U&'[\\0300-\\036F]', '', 'g'), '[^a-zA-Z0-9''-]+', ' ', 'g'))::text`;

const legacyIndex = createDistanceCorpusCache(pool => buildIndex(pool, false));
const groundedIndex = createDistanceCorpusCache(pool => buildIndex(pool, true));

function fold(term) {
  return term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function termKey(term) {
  const clean = fold(term);
  if (!/^[a-z][a-z-]{2,}$/u.test(clean) || FRAME.has(clean)) return null;
  const name = getCanonicalSpiritualTerm(clean);
  return ALIAS_KEY.get(clean) || (name && /^[a-z]{3,}$/u.test(name) ? name : clean);
}

function lexicalTerms(vector, limit, dictionary) {
  const terms = new Map();
  for (const [, raw, locations] of String(vector || '').matchAll(TERM_PATTERN)) {
    let key = dictionary?.get(raw);
    if (key === undefined) {
      key = termKey(raw);
      dictionary?.set(raw, key);
    }
    if (!key) continue;
    const positions = locations?.split(',').map(location => Number.parseInt(location, 10)) || [];
    const kept = limit == null ? positions : positions.filter(position => position <= limit);
    if (kept.length) terms.set(key, [...(terms.get(key) || []), ...kept]);
  }
  return terms;
}

async function buildIndex(pool, grounded) {
  const passageText = grounded
    ? "regexp_replace(u.unit_text, '([.!?]+)[[:space:]]+', '\\1 distsentenceboundaryx ', 'g')"
    : 'u.unit_text';
  const { rows } = await pool.query(`
    SELECT u.answer_unit_id, u.content_hash, r.content_hash AS record_hash,
           length(u.unit_text) AS document_length,
           ${wordVectorSql(passageText)} AS passage_terms,
           ${wordVectorSql('u.associated_question')} AS question_terms
    FROM semantic_qa.answer_units u JOIN semantic_qa.records r USING(source_id)
    WHERE u.language='ENG' AND u.context_complete
      AND coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
      AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
        THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END
    ORDER BY u.source_id,u.answer_unit_id
  `);
  const postings = new Map();
  const dictionary = new Map();
  const average = rows.reduce((sum, row) => sum + row.document_length, 0) / Math.max(1, rows.length) || 1000;
  const documents = rows.map((row, document) => {
    const passage = lexicalTerms(row.passage_terms, undefined, dictionary);
    const sentenceBoundaries = grounded ? passage.get(SENTENCE_BOUNDARY) || [] : [];
    if (grounded) passage.delete(SENTENCE_BOUNDARY);
    // Discovery fields sometimes include verbatim answer text or long correspondence.
    const question = lexicalTerms(row.question_terms, 90, dictionary);
    for (const term of new Set([...passage.keys(), ...question.keys()])) {
      if (!postings.has(term)) postings.set(term, []);
      const body = passage.get(term) || [];
      const context = question.get(term) || [];
      postings.get(term).push(document, body.length, context.length, ...body, ...context);
    }
    return { id: row.answer_unit_id, hash: row.content_hash, recordHash: row.record_hash, sentenceBoundaries,
      lengthFactor: 0.65 + 0.55 * Math.sqrt(row.document_length / average) };
  });
  for (const [term, entries] of postings) {
    let frequency = 0;
    for (let offset = 0; offset < entries.length; offset += 3 + entries[offset + 1] + entries[offset + 2]) frequency++;
    postings.set(term, { entries: Uint32Array.from(entries), frequency });
  }
  return { documents, postings };
}

function clearEnglishPassageCache() {
  legacyIndex.clear();
  groundedIndex.clear();
}

function cleanQuery(value) {
  return String(value || '').replace(/\b(swami|swamiji|sir)\b/giu, ' ')
    .replace(/\b(?:pay|salary|wage) (?:increase|raise)\b/giu, 'increment')
    .replace(/\b(?:level|severity) of\b/giu, 'intensity of')
    .replace(/\bspiritual (?:teacher|guide)s?\b/giu, 'guru')
    .replace(/\bsaint.s staff\b/giu, 'stick')
    .replace(/\b(?:difficult period|hard times?)\b/giu, 'trouble')
    .replace(/\b(?:family responsibilities|family duties)\b/giu, 'family problems')
    .replace(/\b(?:appear|appears|appearing) together\b/giu, 'appear simultaneously')
    .replace(/\b(?:wordly|worldly) duties\b/giu, 'worldly work');
}

function relationParts(query) {
  for (const pattern of RELATIONS) {
    const match = query.match(pattern);
    if (match) return match.slice(1).map(cleanQuery).filter(Boolean);
  }
  return [];
}

function relationTerms(vectors) {
  if (vectors.length !== 2) return null;
  const terms = vectors.map(vector => new Set(lexicalTerms(vector).keys()));
  for (const term of terms[0]) if (terms[1].delete(term)) terms[0].delete(term);
  return terms.every(group => group.size > 0) ? terms : null;
}

function nearWeight(hits, possible, width = 32, boundaries = []) {
  if (hits.length < 2) return 0;
  const points = [];
  for (const [concept, { places, weight }] of hits.entries()) {
    for (const position of places) points.push({ position, weight, concept });
  }
  points.sort((a, b) => a.position - b.position || a.concept - b.concept);
  const counts = new Uint16Array(hits.length);
  let best = 0;
  let weight = 0;
  let left = 0;
  let distinct = 0;
  let boundary = 0;
  for (const point of points) {
    if (counts[point.concept]++ === 0) {
      weight += point.weight;
      distinct++;
    }
    while (boundary < boundaries.length && boundaries[boundary] < point.position) boundary++;
    const sentenceStart = boundaries[boundary - 1] || 0;
    while (point.position - points[left].position > width || points[left].position < sentenceStart) {
      const expired = points[left++];
      if (--counts[expired.concept] === 0) {
        weight -= expired.weight;
        distinct--;
      }
    }
    if (distinct >= 2) best = Math.max(best, weight);
  }
  return best / possible;
}

function retrieve(index, queryTerms, natural, limit, relation, grounded) {
  const { documents, postings } = index;
  const terms = [...queryTerms.keys()].flatMap(term => {
    const hits = postings.get(term);
    if (!hits || hits.frequency > documents.length * 0.65) return [];
    return [{ term, hits, weight: Math.log1p((documents.length - hits.frequency + 0.5) / (hits.frequency + 0.5)) }];
  }).sort((a, b) => a.hits.frequency - b.hits.frequency).slice(0, 12);
  if (terms.length < 2 || (!natural && terms.length < queryTerms.size * 0.7)) return [];
  const possible = terms.reduce((sum, term) => sum + term.weight, 0);
  const possibleRoles = relation?.map(group => terms.reduce((sum, term) => sum + (group.has(term.term) ? term.weight : 0), 0));
  const measureRelation = possibleRoles?.every(weight => weight > 0);
  const candidates = new Map();
  for (const { term, hits: { entries }, weight } of terms) {
    const role = measureRelation ? relation.findIndex(group => group.has(term)) : -1;
    for (let offset = 0; offset < entries.length;) {
      const id = entries[offset++];
      const bodyLength = entries[offset++];
      const questionLength = entries[offset++];
      let candidate = candidates.get(id);
      if (!candidate) candidates.set(id, candidate = { id, weight: 0, hits: 0, passage: [], question: [], bm25: 0, roleA: 0, roleB: 0 });
      candidate.hits++;
      candidate.weight += weight;
      if (bodyLength) candidate.passage.push({ places: entries.subarray(offset, offset + bodyLength), weight });
      offset += bodyLength;
      if (questionLength) candidate.question.push({ places: entries.subarray(offset, offset + questionLength), weight });
      offset += questionLength;
      if (role === 0) candidate.roleA += weight * (bodyLength ? 1 : 0.65);
      if (role === 1) candidate.roleB += weight * (bodyLength ? 1 : 0.65);
      const frequency = Math.min(8, bodyLength) + Math.min(2, questionLength) * 0.8;
      candidate.bm25 += weight * frequency / (frequency + documents[id].lengthFactor);
    }
  }
  return [...candidates.values()].filter(row => row.hits >= 2 && row.weight / possible >= (natural ? 0.28 : 0.72))
    .sort((a, b) => b.bm25 - a.bm25 || a.id - b.id)
    .slice(0, limit * 4)
    .flatMap(row => {
      const coverage = row.weight / possible;
      const passage = nearWeight(row.passage, possible);
      const question = nearWeight(row.question, possible);
      if (Math.max(passage, question) < (natural ? 0.18 : 0.68)) return [];
      const relationFit = measureRelation ? Math.min(row.roleA / possibleRoles[0], row.roleB / possibleRoles[1]) : 0;
      const haveOneSide = measureRelation && (row.roleA > 0 || row.roleB > 0);
      const relationWeight = haveOneSide ? 0.85 + 0.45 * relationFit : 1;
      const local = grounded ? nearWeight(row.passage, possible, 24, documents[row.id].sentenceBoundaries) : 0;
      const questionPhrase = grounded ? nearWeight(row.question, possible, 14) : 0;
      const passageWeight = grounded ? 0.22 * passage ** 2 + 0.14 * local ** 2 : 0.36 * passage ** 2;
      const questionWeight = grounded ? 0.20 * question ** 2 + 0.08 * questionPhrase ** 2 : 0.28 * question ** 2;
      const strength = relationWeight * (0.24 * coverage ** 2 + passageWeight + questionWeight + 0.12 * (row.bm25 / possible));
      return [{ id: row.id, strength, coverage, passage, question }];
    })
    .sort((a, b) => b.strength - a.strength || a.id - b.id)
    .slice(0, limit);
}

function hasLocalAnchor(index, terms) {
  const lowestFrequency = [...terms].sort((a, b) => index.postings.get(a).frequency - index.postings.get(b).frequency);
  const required = lowestFrequency.slice(0, terms.length >= 5 ? 3 : 2);
  const hitsByDocument = new Map();
  for (const term of required) {
    const { entries } = index.postings.get(term);
    for (let offset = 0; offset < entries.length;) {
      const id = entries[offset++];
      const bodyLength = entries[offset++];
      const questionLength = entries[offset++];
      let hit = hitsByDocument.get(id);
      if (!hit) hitsByDocument.set(id, hit = { passage: [], question: [] });
      if (bodyLength) hit.passage.push({ places: entries.subarray(offset, offset + bodyLength), weight: 1 });
      offset += bodyLength;
      if (questionLength) hit.question.push({ places: entries.subarray(offset, offset + questionLength), weight: 1 });
      offset += questionLength;
    }
  }
  return [...hitsByDocument].some(([id, hit]) => {
    const boundaries = index.documents[id].sentenceBoundaries;
    return nearWeight(hit.passage, required.length, 36, boundaries) === 1
      || nearWeight(hit.question, required.length, 18) === 1;
  });
}

function hasCorpusQuestionSupport(index, variants, hasDomainWord) {
  return variants.some(({ vector }) => {
    const terms = [...lexicalTerms(vector).keys()];
    const supported = terms.filter(term => index.postings.has(term));
    const informative = supported.filter(term => index.postings.get(term).frequency <= index.documents.length * 0.35);
    if (informative.length < 2 || supported.length / terms.length < 0.70) return false;
    return hasDomainWord || hasLocalAnchor(index, informative);
  });
}

function conversationalVariant(query) {
  return query.replace(/\b(?:get|getting) ready for\b/giu, 'prepare for')
    .replace(/\bfocus(?:ing)? on\b/giu, 'concentrate on')
    .replace(/\b(?:am|are|is|was|were) supposed to\b/giu, 'should');
}

async function prepareEnglishPassageSearch(pool, original, repaired, { grounded = false, normalized } = {}) {
  if (!QUESTION.test(original) && !(grounded && /\?\s*$/u.test(original))) return null;
  if (grounded && (NON_LATIN_LETTER.test(original)
      || [...original.matchAll(SOURCE_IDENTIFIER)].some(([token]) => !/^\d+(?:st|nd|rd|th)$/iu.test(token)))) return null;
  const cleaned = cleanQuery(original);
  const translations = [...new Set([original, repaired, cleaned, grounded && conversationalVariant(cleaned), grounded && normalized])]
    .filter(Boolean);
  const clauses = relationParts(original);
  const repairedWords = new Set(repaired?.toLowerCase().match(/[\p{L}\p{M}]+/gu) || []);
  const names = grounded ? [...new Set([...original.matchAll(CAPITALIZED_WORD)]
    .filter(match => match.index > 0).map(match => match[0])
    .filter(name => !repaired || repairedWords.has(name.toLowerCase())))].slice(0, 12) : [];
  const [index, { rows: queries }] = await Promise.all([
    (grounded ? groundedIndex : legacyIndex).get(pool),
    pool.query(`SELECT ${wordVectorSql('text')} AS vector
      FROM unnest($1::text[]) WITH ORDINALITY q(text, ord) ORDER BY ord`, [[...translations, ...clauses, ...names]]),
  ]);
  const variants = queries.slice(0, translations.length);
  const clauseEnd = translations.length + clauses.length;
  if (grounded && (!hasCorpusQuestionSupport(index, variants, isAnchoredPassageQuestion(original))
      || queries.slice(clauseEnd).some(row => [...lexicalTerms(row.vector).keys()].some(term => !index.postings.has(term))))) return null;
  return { index, variants, relation: relationTerms(queries.slice(translations.length, clauseEnd).map(row => row.vector)),
    natural: grounded || isAnchoredPassageQuestion(original), grounded };
}

async function retrieveEnglishPassageCandidates(pool, original, repaired, limit = 90, prepared) {
  const search = prepared || await prepareEnglishPassageSearch(pool, original, repaired);
  if (!search) return [];
  const { index, variants, relation, natural, grounded } = search;
  const matches = new Map();
  for (const [indexInQuery, row] of variants.entries()) {
    for (const hit of retrieve(index, lexicalTerms(row.vector), natural, limit, relation, grounded)) {
      if (indexInQuery > 0) hit.strength *= 0.90;
      if (hit.strength > (matches.get(hit.id)?.strength || 0)) matches.set(hit.id, hit);
    }
  }
  const ranked = [...matches.values()].sort((a, b) => b.strength - a.strength || a.id - b.id).slice(0, limit);
  if (!ranked.length) return [];
  const ids = ranked.map(row => index.documents[row.id].id);
  const { rows } = await pool.query(`
    SELECT u.source_id,r.question,''::text AS answer,r.metadata,r.content_hash,
           u.associated_question AS matched_discovery_text,u.answer_unit_id AS matched_answer_unit_id,
           u.unit_text AS matched_answer_unit_text,u.start_offset AS matched_answer_unit_start,
           u.content_hash AS matched_answer_unit_hash
    FROM semantic_qa.answer_units u JOIN semantic_qa.records r USING(source_id)
    WHERE u.answer_unit_id=ANY($1::text[]) AND u.language='ENG' AND u.context_complete
      AND coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
      AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
        THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END
  `, [ids]);
  const intent = INTENT.find(entry => entry.query.test(original));
  const hydrated = new Map(rows.map(row => [row.matched_answer_unit_id, row]));
  return ranked.flatMap(match => {
    const { id, hash, recordHash } = index.documents[match.id];
    const row = hydrated.get(id);
    if (!row || row.content_hash !== recordHash || row.matched_answer_unit_hash !== hash) return [];
    const intentFit = intent?.passage.test(row.matched_answer_unit_text) ? 1 : 0;
    return [{ ...row, english_passage_evidence: {
      strength: match.strength * (1 + 0.12 * intentFit * Math.max(match.passage, match.question)),
      verified: match.coverage >= 0.32 && Math.max(match.passage, match.question) >= 0.30,
    } }];
  });
}

function isAnchoredPassageQuestion(query) {
  return DOMAIN.test(query) && QUESTION.test(query);
}

function addEnglishPassageCandidates(baseline, passages, weight) {
  const byId = new Map(passages.map(row => [row.matched_answer_unit_id, row]));
  const retained = baseline.map(row => {
    const passage = byId.get(row.matched_answer_unit_id);
    if (!passage) return row;
    byId.delete(row.matched_answer_unit_id);
    if (passage.matched_answer_unit_hash !== row.matched_answer_unit_hash
        || passage.content_hash !== row.content_hash) return row;
    return { ...row, english_passage_evidence: passage.english_passage_evidence, english_passage_weight: weight };
  });
  return retained.concat([...byId.values()].map(row => ({ ...row, english_passage_weight: weight })));
}

module.exports = { retrieveEnglishPassageCandidates, addEnglishPassageCandidates, prepareEnglishPassageSearch,
  clearEnglishPassageCache, isAnchoredPassageQuestion, lexicalTerms, nearWeight, relationParts, cleanQuery };
