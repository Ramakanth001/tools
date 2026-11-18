const { lexicalTerms } = require('./distanceEnglishPassages');
const { buildLexicalAssociations } = require('./distanceLexicalAssociations');
const { buildPhraseLinks } = require('./distancePhraseLinks');
const { orderedPairs } = require('./distanceAliasCatalogue');
const { domainConcepts, domainEvidence } = require('./distanceDomainPhrases');

const answerTypes = [
  ['sequence', /\b(?:before|after|first|sequence|order|priority|precede)\b/iu,
    /\b(?:first|next|later|then|before|after|prior|precede|subsequent|followed)\b/gu],
  ['contrast', /\b(?:contrast|differ|difference|distinguish|compare|versus|reconcile)\b/iu,
    /\b(?:whereas|unlike|while|both|difference|different|however|but|similarly|respectively)\b/gu],
  ['condition', /\b(?:under what condition|in what circumstances|what happens when|when|whether)\b/iu,
    /\b(?:if|when|only|unless|until|provided|condition|whenever|otherwise)\b/gu],
  ['reason', /\b(?:why|reason|cause|purpose)\b/iu,
    /\b(?:because|reason|cause|therefore|since|hence|so that|due to|purpose)\b/gu],
  ['definition', /\b(?:meaning|mean|define|definition|symbol|represent|interpret|what is|what are)\b/iu,
    /\b(?:means|meaning|defined|refers|represents|stands for|symbolizes|is called|is known as)\b/gu],
  ['source', /\b(?:where|what (?:book|text|scripture|source)|which (?:book|text|scripture|source))\b/iu,
    /\b(?:purana\w*|veda\w*|scripture\w*|upanishad\w*|bible|quran|gita|verse|chapter|says|states)\b/gu],
];

const FIELD_FEATURES = ['coverage', 'frequency', 'window', 'phrase', 'keyCoverage'];
const FEATURES = Object.freeze([
  'existingRank', 'existingScore', 'bodyScore', 'passageScore', 'titleScore',
  'questionScore', 'intentScore', 'spanScore', 'exactMatch',
  ...['answer', 'question', 'title'].flatMap(field => FIELD_FEATURES.map(name => field + '.' + name)),
  'answer.markerLocality', 'question.intentAgreement', 'roleBalance', 'exactQuotation', 'answer.density',
  'jointEvidence', 'bodyBeatsTopic',
  'associatedTerms.coverage', 'associatedTerms.nearAnswer',
  'answer.roleWindow', 'answer.nameEvidence', 'question.nameEvidence',
  'conditionalAnswer', 'comparisonAnswer', 'orderedAnswer', 'definitionAnswer', 'causalAnswer', 'citedSourceAnswer',
  'linkedQuestions.coverage', 'linkedQuestions.window',
  'supplemental.answer', 'supplemental.question',
  'repaired.answerCoverage', 'repaired.answerWindow', 'repaired.questionWindow',
  'answer.openingCoverage',
  'answer.pivotRoleCoverage', 'answer.reversePivotRoleCoverage',
  'aliasPostings.support', 'aliasPostings.directSupport', 'aliasPostings.roles',
  'aliasPhrases.coverage', 'aliasPhrases.best',
  'aliasQuestion.coverage', 'aliasQuestion.window',
  'domainAnswer.coverage', 'domainAnswer.window', 'domainQuestion.coverage',
]);

function vectorSql(expression) {
  return `to_tsvector('english'::regconfig, regexp_replace(
    regexp_replace(normalize(${expression}, NFKD), U&'[\\0300-\\036F]', '', 'g'),
    '[^a-zA-Z0-9]+', ' ', 'g'))::text`;
}

function normalizeEnglish(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function positionIndex(text) {
  const result = [];
  for (const word of text.matchAll(/\S+/gu)) result.push(word.index);
  return result;
}

function characterToWord(index, character) {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const middle = (high + low) >>> 1;
    if (index[middle] <= character) low = middle + 1;
    else high = middle;
  }
  return low;
}

function createEvidenceCorpus(rows, { associations = true, links = true, domainPhrases = false } = {}) {
  const documents = new Map();
  const frequencies = new Map();
  const dictionary = new Map();
  for (const row of rows) {
    const answer = lexicalTerms(row.answer_vector, undefined, dictionary);
    const question = lexicalTerms(row.question_vector, 90, dictionary);
    const title = lexicalTerms(row.title_vector, 42, dictionary);
    for (const term of new Set([...answer.keys(), ...question.keys(), ...title.keys()])) {
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
    documents.set(row.answer_unit_id, {
      sourceId: row.source_id || row.answer_unit_id,
      sourceGroup: row.source_group || row.source_id || row.answer_unit_id,
      unitKind: row.unit_kind,
      id: row.answer_unit_id, hash: row.answer_hash,
      answer, question, title, questionText: row.question_text, answerText: normalizeEnglish(row.answer_text),
      sourceText: row.answer_text || '',
      domainAnswer: domainPhrases ? domainConcepts(row.answer_text) : null,
      domainQuestion: domainPhrases ? domainConcepts(row.question_text) : null,
      opening: null,
      // Parse marker positions lazily, only for units that are ranked.
      markers: null,
    });
  }
  if (links) {
    for (const [document, neighbors] of buildPhraseLinks(documents, frequencies)) document.neighbors = neighbors;
  }
  return { documents, frequencies, domainPhrases, associations: associations ? buildLexicalAssociations(documents) : new Map() };
}

async function loadEvidenceCorpus(pool, options) {
  const { rows } = await pool.query(`
    SELECT u.answer_unit_id, u.source_id, r.source_group, u.unit_kind, u.content_hash AS answer_hash,
           u.unit_text AS answer_text, u.associated_question AS question_text,
           ${vectorSql('u.unit_text')} AS answer_vector,
           ${vectorSql('u.associated_question')} AS question_vector,
           ${vectorSql('r.question')} AS title_vector
    FROM semantic_qa.answer_units u JOIN semantic_qa.records r USING(source_id)
    WHERE u.language='ENG' AND u.context_complete
      AND coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
      AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
        THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END
    ORDER BY u.source_id, u.answer_unit_id
  `);
  return createEvidenceCorpus(rows, options);
}

function buildEvidenceQuery(text, vector, roleVectors, corpus) {
  const terms = lexicalTerms(vector);
  const termsByRarity = [...terms.keys()].map(term => {
    const frequency = corpus.frequencies.get(term) || 0;
    return { term, frequency,
      weight: Math.min(5.5, Math.log1p((corpus.documents.size - frequency + 0.5) / (frequency + 0.5))) };
  }).filter(term => term.frequency > 0 && term.frequency < corpus.documents.size * 0.60)
    .sort((a, b) => a.frequency - b.frequency || a.term.localeCompare(b.term)).slice(0, 16);
  const sorted = termsByRarity.slice().sort((a, b) => terms.get(a.term)[0] - terms.get(b.term)[0]);
  const roles = roleVectors.map(value => new Set(lexicalTerms(value).keys()));
  if (roles.length === 2) for (const term of roles[0]) if (roles[1].delete(term)) roles[0].delete(term);
  const keyTerms = new Set(termsByRarity.slice(0, Math.ceil(sorted.length / 3)).map(term => term.term));
  const types = answerTypes.flatMap(([key, intent]) => intent.test(text) ? [key] : []);
  const quotations = [...text.matchAll(/["“]([^"”]+)["”]|(?<!\p{L})'([^'\r\n]+)'(?!\p{L})/gu)]
    .map(match => normalizeEnglish(match[1] || match[2])).filter(phrase => phrase.includes(' '));
  const names = [...new Set([...text.matchAll(/\b\p{Lu}[\p{L}\p{M}]{2,}(?:\s+\p{Lu}[\p{L}\p{M}]{2,})*/gu)]
    .filter(match => match.index > 0)
    .map(match => normalizeEnglish(match[0]))
    .filter(name => !['swami', 'swamiji', 'god', 'lord', 'divine', 'english'].includes(name)))];
  return {
    terms: sorted, majorWeight: [...keyTerms].reduce((sum, term) => sum + termsByRarity.find(item => item.term === term).weight, 0),
    totalWeight: sorted.reduce((sum, term) => sum + term.weight, 0), keyTerms, types, quotations, names,
    phrasePairs: orderedPairs(terms),
    domain: corpus.domainPhrases ? domainConcepts(text) : new Map(),
    roles: roles.length === 2 && roles.every(role => role.size) ? roles : [],
    associations: sorted.map(term => (corpus.associations.get(term.term) || []).filter(related => !terms.has(related.term))),
  };
}

function forwardDistance(a, b, limit) {
  let left = 0;
  let right = 0;
  let best = limit + 1;
  while (left < a.length && right < b.length) {
    if (b[right] <= a[left]) right++;
    else {
      best = Math.min(best, b[right] - a[left]);
      if (best === 1) return best;
      left++;
    }
  }
  return best;
}

function windowCoverage(points, weights, size, markers) {
  if (!points.length) return { coverage: 0, aligned: 0 };
  const counts = new Uint16Array(weights.length);
  let total = 0;
  let maximum = 0;
  let aligned = 0;
  let start = 0;
  let marker = 0;
  let distinct = 0;
  for (const point of points) {
    if (counts[point.term]++ === 0) {
      total += weights[point.term];
      distinct++;
    }
    while (point.position - points[start].position > size) {
      const expired = points[start++];
      if (--counts[expired.term] === 0) {
        total -= weights[expired.term];
        distinct--;
      }
    }
    if (distinct < 2) continue;
    maximum = Math.max(maximum, total);
    while (markers && marker < markers.length && markers[marker] < points[start].position - 8) marker++;
    if (markers?.[marker] <= point.position + 8) aligned = Math.max(aligned, total);
  }
  return { coverage: maximum, aligned };
}

function fieldEvidence(field, query, markers) {
  if (!field || !query.totalWeight) return { features: [0, 0, 0, 0, 0], aligned: 0 };
  let coverage = 0;
  let frequency = 0;
  let keyCoverage = 0;
  let phrase = 0;
  let phrasePotential = 0;
  const points = [];
  const weights = query.terms.map(term => term.weight);
  for (const [i, { term, weight }] of query.terms.entries()) {
    const positions = field.get(term)?.slice().sort((a, b) => a - b) || [];
    if (positions.length) {
      coverage += weight;
      frequency += weight * positions.length / (positions.length + 1.2);
      if (query.keyTerms.has(term)) keyCoverage += weight;
      for (const position of positions) points.push({ term: i, position });
    }
    if (i) {
      const previous = query.terms[i - 1];
      const pairWeight = Math.sqrt(weight * previous.weight);
      phrasePotential += pairWeight;
      const gap = positions.length ? forwardDistance(field.get(previous.term)?.slice().sort((a, b) => a - b) || [], positions, 12) : 13;
      if (gap <= 12) phrase += pairWeight / Math.sqrt(gap);
    }
  }
  points.sort((a, b) => a.position - b.position || a.term - b.term);
  const window = windowCoverage(points, weights, 28, markers);
  return { features: [
    coverage / query.totalWeight, frequency / query.totalWeight, window.coverage / query.totalWeight,
    phrase / (phrasePotential || 1), keyCoverage / (query.majorWeight || 1),
  ], aligned: window.aligned / query.totalWeight };
}

function answerMarkers(document, requestedTypes) {
  if (!document || !requestedTypes.length) return [];
  if (!document.markers) {
    const index = positionIndex(document.answerText);
    document.markers = new Map(answerTypes.map(([key, , expression]) => [
      key, [...document.answerText.matchAll(expression)].map(marker => characterToWord(index, marker.index)),
    ]));
  }
  return requestedTypes.flatMap(type => document.markers.get(type)).sort((a, b) => a - b);
}

function coveredRoles(document, roles) {
  if (!document || roles.length !== 2) return 0;
  return Math.min(...roles.map(group => [...group].reduce((sum, term) => sum
    + (document.answer.has(term) ? 1 : document.question.has(term) ? 0.5 : 0), 0) / group.size));
}

function localRoleEvidence(document, roles) {
  if (!document || roles.length !== 2) return 0;
  const points = [];
  const sizes = roles.map(group => group.size);
  const roleOf = [];
  for (const [role, group] of roles.entries()) {
    for (const term of group) {
      const index = roleOf.length;
      roleOf.push(role);
      for (const position of document.answer.get(term) || []) points.push({ position, index });
    }
  }
  points.sort((a, b) => a.position - b.position);
  let best = 0;
  let start = 0;
  const counts = new Uint16Array(roleOf.length);
  const present = [0, 0];
  for (const point of points) {
    if (counts[point.index]++ === 0) present[roleOf[point.index]]++;
    while (point.position - points[start].position > 42) {
      const expired = points[start++];
      if (--counts[expired.index] === 0) present[roleOf[expired.index]]--;
    }
    best = Math.max(best, Math.min(present[0] / sizes[0], present[1] / sizes[1]));
  }
  return best;
}

function pivotRoleEvidence(document, roles, types) {
  if (!document?.markers || roles.length !== 2) return [0, 0];
  const pivots = types.filter(type => ['contrast', 'sequence', 'condition'].includes(type))
    .flatMap(type => document.markers.get(type));
  if (!pivots.length) return [0, 0];
  const locations = roles.map(group => [...group].map(term => document.answer.get(term) || []));
  const best = [0, 0];
  for (const pivot of pivots) {
    const sides = locations.map(group => {
      let before = 0;
      let after = 0;
      for (const positions of group) {
        if (positions.some(position => position < pivot && pivot - position <= 25)) before++;
        if (positions.some(position => position > pivot && position - pivot <= 25)) after++;
      }
      return [before / group.length, after / group.length];
    });
    best[0] = Math.max(best[0], Math.min(sides[0][0], sides[1][1]));
    best[1] = Math.max(best[1], Math.min(sides[1][0], sides[0][1]));
  }
  return best;
}

function associationEvidence(document, query) {
  if (!document || !query.totalWeight) return [0, 0];
  const original = query.terms.flatMap(({ term }) => document.answer.get(term) || []).sort((a, b) => a - b);
  // An associated term supports an already grounded passage. It cannot stand
  // alone as evidence for a different topic.
  if (!original.length) return [0, 0];
  let covered = 0;
  let nearby = 0;
  for (const [index, { term, weight }] of query.terms.entries()) {
    if (document.answer.has(term)) continue;
    let best = 0;
    let bestNearby = 0;
    for (const pair of query.associations[index]) {
      const positions = document.answer.get(pair.term);
      if (!positions) continue;
      const ordered = positions.slice().sort((a, b) => a - b);
      const strength = Math.min(1, pair.weight) * weight;
      best = Math.max(best, strength);
      if (Math.min(forwardDistance(original, ordered, 24), forwardDistance(ordered, original, 24)) <= 24) {
        bestNearby = Math.max(bestNearby, strength);
      }
    }
    covered += best;
    nearby += bestNearby;
  }
  return [covered / query.totalWeight, nearby / query.totalWeight];
}

function linkedQuestionEvidence(neighbors, query) {
  let coverage = 0;
  let window = 0;
  for (const neighbor of neighbors || []) {
    const { features } = fieldEvidence(neighbor.document.question, query);
    coverage = Math.max(coverage, features[0] * neighbor.strength);
    window = Math.max(window, features[2] * neighbor.strength);
  }
  return [coverage, window];
}

function retrieveAnswerEvidence(corpus, queries) {
  const answers = [];
  const questions = [];
  const hits = new Map();
  for (const [id, document] of corpus.documents) {
    let bestAnswer = 0;
    let bestQuestion = 0;
    for (const [variant, query] of queries.entries()) {
      if (!query.totalWeight) continue;
      let count = 0;
      let rare = false;
      let answer = 0;
      let question = 0;
      for (const { term, weight, frequency } of query.terms) {
        const occurrences = document.answer.get(term)?.length || 0;
        if (occurrences) {
          count++;
          answer += weight * occurrences / (occurrences + 0.75);
          if (frequency <= 36) rare = true;
        }
        if (document.question.has(term)) question += weight;
      }
      const translationWeight = variant ? 0.85 : 1.0;
      if (count >= 2 || (rare && document.answerText.length <= 1250)) {
        const norm = Math.max(0.5, 0.55 + 0.2 * Math.log1p(document.answerText.length / 380));
        const [concepts, local] = domainEvidence(query.domain, document.domainAnswer);
        bestAnswer = Math.max(bestAnswer, translationWeight * (answer / query.totalWeight / norm + 0.16 * (concepts + local)));
      }
      if (question / query.totalWeight >= 0.30) bestQuestion = Math.max(bestQuestion, translationWeight * question / query.totalWeight);
    }
    if (bestAnswer > 0.13) answers.push({ id, score: bestAnswer });
    if (bestQuestion > 0.35) questions.push({ id, score: bestQuestion });
    if (bestAnswer > 0 || bestQuestion > 0) hits.set(id, [bestAnswer, bestQuestion]);
  }
  const top = (entries, limit) => entries.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit).map(row => row.id);
  const supplemental = [...new Set([...top(answers, 65), ...top(questions, 35)])];
  return { supplemental, hits };
}

function buildAnswerFeatures(candidate, column, query, document, repairedQuery) {
  const answer = fieldEvidence(document?.answer, query, answerMarkers(document, query.types));
  const question = fieldEvidence(document?.question, query);
  const title = fieldEvidence(document?.title, query);
  const scaleScore = value => Math.log1p(Math.max(0, Number(value) || 0) / 100000);
  const existingBody = scaleScore(candidate.englishBodyScore);
  const existingPassage = scaleScore(candidate.englishPassageScore);
  const bodyText = ' ' + (document?.answerText || '') + ' ';
  const questionText = ' ' + normalizeEnglish(document?.questionText) + ' ';
  const contains = (text, phrase) => text.includes(' ' + phrase + ' ');
  const quote = query.quotations.length ? query.quotations.filter(phrase => contains(bodyText, phrase) || contains(questionText, phrase)).length / query.quotations.length : 0;
  const nameEvidence = text => query.names.length ? query.names.filter(name => contains(text, name)).length / query.names.length : 0;
  const bodyByType = ['condition', 'contrast', 'sequence', 'definition', 'reason', 'source'].map(type => {
    if (!query.types.includes(type) || !document?.markers) return 0;
    const positions = document.markers.get(type);
    return positions.length ? fieldEvidence(document.answer, query, positions).aligned : 0;
  });
  const repairedAnswer = fieldEvidence(document?.answer, repairedQuery || query);
  const repairedQuestion = fieldEvidence(document?.question, repairedQuery || query);
  if (document && !document.opening) {
    document.opening = new Map([...document.answer].flatMap(([term, positions]) => {
      const hits = positions.filter(position => position <= 65);
      return hits.length ? [[term, hits]] : [];
    }));
  }
  const opening = fieldEvidence(document?.opening, query);
  const agreement = document && query.types.some(type => answerTypes.some(([key, test]) => key === type && test.test(document.questionText || '')));
  return [
    1 / (1 + Math.log1p(column)), scaleScore(candidate.totalScore), existingBody, existingPassage,
    scaleScore(candidate.titleScore), scaleScore(candidate.discoveryScore), scaleScore(candidate.intentScore),
    scaleScore(candidate.minimalSpanScore), candidate.exactReference || candidate.discoveryScore >= 1500000 ? 1 : 0,
    ...answer.features, ...question.features, ...title.features,
    answer.aligned, agreement ? 1 : 0, coveredRoles(document, query.roles), quote,
    answer.features[2] / Math.sqrt(1 + (document?.answerText.length || 0) / 1200),
    Math.sqrt(answer.features[2] * question.features[2]),
    answer.features[2] - Math.max(question.features[2], title.features[2]),
    ...associationEvidence(document, query),
    localRoleEvidence(document, query.roles), nameEvidence(bodyText), nameEvidence(questionText), ...bodyByType,
    ...linkedQuestionEvidence(document?.neighbors, query),
    ...(candidate.supplementalEvidence || [0, 0]),
    repairedAnswer.features[0], repairedAnswer.features[2], repairedQuestion.features[2], opening.features[0],
    ...pivotRoleEvidence(document, query.roles, query.types),
    ...(candidate.aliasEvidence || [0, 0, 0, 0, 0]),
    ...linkedQuestionEvidence(document?.aliasQuestions, query),
    ...domainEvidence(query.domain, document?.domainAnswer),
    domainEvidence(query.domain, document?.domainQuestion)[0],
  ];
}

module.exports = { FEATURES, vectorSql, createEvidenceCorpus, loadEvidenceCorpus, buildEvidenceQuery, buildAnswerFeatures,
  retrieveAnswerEvidence, forwardDistance, windowCoverage };
