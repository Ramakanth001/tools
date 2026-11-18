const assert = require('node:assert/strict');
const { cleanQuery, isAnchoredPassageQuestion, relationParts } = require('./distanceEnglishPassages');
const { FEATURES, vectorSql, loadEvidenceCorpus, buildEvidenceQuery, buildAnswerFeatures, retrieveAnswerEvidence } = require('./distanceAnswerEvidence');
const { createDistanceCorpusCache } = require('./distanceCorpusCache');

const PROTECTED_QUESTION_RANK = 5;
const STRONG_LEXICAL_TITLE_SCORE = 400000;
const STRONG_ASSOCIATED_QUESTION_SCORE = 240000;
const ALIGNMENT_FEATURES = Object.fromEntries(
  ['answer.window', 'answer.keyCoverage', 'question.window', 'question.phrase', 'question.keyCoverage']
    .map(feature => [feature, FEATURES.indexOf(feature)])
);

function scopedEvidence(features) {
  const value = feature => features[ALIGNMENT_FEATURES[feature]];
  const passage = value('answer.window') * (0.55 + 0.45 * value('answer.keyCoverage'));
  const question = (0.7 * value('question.window') + 0.3 * value('question.phrase')) * value('question.keyCoverage');
  return Math.max(passage, question);
}

const rankedScale = scores => {
  const low = Math.min(...scores);
  const range = Math.max(1e-8, Math.max(...scores) - low);
  return scores.map(score => (score - low) / range);
};

function originalLexicalScore(candidate) {
  return candidate.totalScore - (candidate.englishBodyScore || 0) - (candidate.englishPassageScore || 0);
}

function retainStrongQuestionMatch(ranked, ordered) {
  let incumbent = ranked[0];
  for (const candidate of ranked) {
    if (originalLexicalScore(candidate) > originalLexicalScore(incumbent)) incumbent = candidate;
  }
  const hasQuestionSupport = incumbent.titleScore >= STRONG_LEXICAL_TITLE_SCORE
    || incumbent.discoveryScore >= STRONG_ASSOCIATED_QUESTION_SCORE;
  if (!incumbent.answerUnitId || !hasQuestionSupport) return ordered;
  const position = ordered.findIndex(row => row.candidate === incumbent);
  if (position < PROTECTED_QUESTION_RANK) return ordered;

  const replacement = PROTECTED_QUESTION_RANK - 1;
  const promoted = { ...ordered[position], score: ordered[replacement].score };
  ordered.splice(position, 1);
  ordered.splice(replacement, 0, promoted);
  return ordered;
}

function retainIncumbentPassages(ranked, ordered, incumbentUnits) {
  const incumbents = ranked.filter(candidate => incumbentUnits.has(candidate.answerUnitId))
    .sort((a, b) => originalLexicalScore(b) - originalLexicalScore(a)).slice(0, 3);
  const required = new Set(incumbents);
  for (const candidate of incumbents) {
    const position = ordered.findIndex(row => row.candidate === candidate);
    if (position < PROTECTED_QUESTION_RANK) continue;
    let replacement = PROTECTED_QUESTION_RANK - 1;
    while (required.has(ordered[replacement].candidate)) replacement--;
    const promoted = { ...ordered[position], score: ordered[replacement].score };
    ordered.splice(position, 1);
    const [displaced] = ordered.splice(replacement, 1, promoted);
    ordered.splice(PROTECTED_QUESTION_RANK, 0, { ...displaced, score: ordered[PROTECTED_QUESTION_RANK - 1].score });
  }
}

function createLexicalRanker(model) {
  assert.equal(model.version, 1);
  assert.ok(model.features.length && model.features.length === model.coefficients.length);
  const weights = model.features.map((feature, index) => {
    const column = FEATURES.indexOf(feature);
    assert.ok(column >= 0 && Number.isFinite(model.coefficients[index]), `Invalid rank feature ${feature}`);
    return { column, coefficient: model.coefficients[index] };
  });
  assert.ok(Number.isFinite(model.blend) && model.blend > 0 && model.blend <= 1);
  const { get: prepare } = createDistanceCorpusCache(loadEvidenceCorpus);

  async function rank(pool, query, ranked, { limit, evaluateCandidate, groundedEnglish = false, repairedQuery, incumbentUnits }) {
    if (!ranked.length || (!groundedEnglish && !isAnchoredPassageQuestion(query))) return null;
    const best = ranked[0];
    if (model.keepStrongMatches && (best.totalScore >= 1150000 || best.discoveryScore >= 1500000)) return null;
    const values = [query, cleanQuery(groundedEnglish && repairedQuery ? repairedQuery : query), ...relationParts(query)];
    const [corpus, { rows }] = await Promise.all([
      prepare(pool),
      pool.query(`SELECT ${vectorSql('input.text')} AS vector
        FROM unnest($1::text[]) WITH ORDINALITY input(text, position) ORDER BY input.position`, [values]),
    ]);
    const roles = rows.slice(2).map(row => row.vector);
    const original = buildEvidenceQuery(query, rows[0].vector, roles, corpus);
    const repaired = buildEvidenceQuery(query, rows[1].vector, roles, corpus);
    const evidence = retrieveAnswerEvidence(corpus, [original, repaired]);
    const existing = new Set(ranked.map(candidate => candidate.answerUnitId));
    const additions = evidence.supplemental.filter(id => !existing.has(id));
    const candidates = ranked.concat(additions.map(id => ({ answerUnitId: id, answerUnitHash: corpus.documents.get(id).hash, supplemental: true })));
    const features = candidates.map((candidate, index) => {
      const document = corpus.documents.get(candidate.answerUnitId);
      return buildAnswerFeatures({ ...candidate, supplementalEvidence: evidence.hits.get(candidate.answerUnitId),
        exactReference: candidate.decisionSummary?.startsWith('Exact source title') },
      index, original, document?.hash === candidate.answerUnitHash ? document : null, repaired);
    });
    const oldScores = rankedScale(features.map(row => row[1]));
    const learnedScores = rankedScale(features.map(row => weights.reduce((score, item) => score + row[item.column] * item.coefficient, 0)));
    const localScores = groundedEnglish ? features.map(scopedEvidence) : null;
    let blend = model.blend;
    if (model.adaptive) blend *= 1 - 0.7 * Math.min(1, Math.max(0, (best.totalScore - 300000) / 900000));
    const ordered = candidates.map((candidate, index) => {
      const blended = blend * learnedScores[index] + (1 - blend) * oldScores[index];
      return { candidate, index, score: localScores ? 0.86 * blended + 0.14 * localScores[index] : blended };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    if (model.protectStrongQuestion && incumbentUnits?.size) retainIncumbentPassages(ranked, ordered, incumbentUnits);
    else if (model.protectStrongQuestion) retainStrongQuestionMatch(ranked, ordered);
    // Hydrate only supplemental passages that can appear on the returned page.
    const newIds = ordered.slice(0, limit).filter(row => row.candidate.supplemental).map(row => row.candidate.answerUnitId);
    const hydrated = new Map();
    if (newIds.length) {
      const { rows: records } = await pool.query(`
        SELECT r.source_id,r.question,''::text AS answer,r.metadata,r.content_hash,
               u.associated_question AS matched_discovery_text,u.answer_unit_id AS matched_answer_unit_id,
               u.unit_text AS matched_answer_unit_text,u.start_offset AS matched_answer_unit_start,
               u.content_hash AS matched_answer_unit_hash
        FROM semantic_qa.records r JOIN semantic_qa.answer_units u USING(source_id)
        WHERE u.answer_unit_id=ANY($1::text[]) AND u.language='ENG' AND u.context_complete
          AND coalesce(lower(r.metadata->>'ambiguous'),'false')<>'true'
          AND CASE WHEN coalesce(r.metadata->>'answer_unit_count','') ~ '^[0-9]+$'
            THEN (r.metadata->>'answer_unit_count')::numeric>0 ELSE true END
      `, [newIds]);
      for (const row of records) {
        const document = corpus.documents.get(row.matched_answer_unit_id);
        if (document?.hash !== row.matched_answer_unit_hash) continue;
        const candidate = evaluateCandidate({ ...row, english_passage_evidence: { verified: true, strength: 0 }, english_passage_weight: 0 });
        if (candidate) hydrated.set(candidate.answerUnitId, candidate);
      }
    }
    const matches = [];
    for (const row of ordered) {
      const candidate = row.candidate.supplemental ? hydrated.get(row.candidate.answerUnitId) : row.candidate;
      if (!candidate) continue;
      const totalScore = row.score * best.totalScore;
      matches.push({ ...candidate, totalScore, score: Math.round(totalScore * 10) / 10 });
      if (matches.length === limit) break;
    }
    return { matches, rankedAnswerUnitIds: ordered.map(row => row.candidate.answerUnitId).filter(Boolean) };
  }
  return { prepare, rank };
}

module.exports = { createLexicalRanker, retainStrongQuestionMatch, retainIncumbentPassages };
