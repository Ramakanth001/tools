const assert = require('node:assert/strict');

function orderedPairs(terms) {
  const positions = new Map();
  for (const [term, hits] of terms) for (const position of hits) if (!positions.has(position)) positions.set(position, term);
  const sequence = [...positions].sort((a, b) => a[0] - b[0]);
  const pairs = new Set();
  for (let index = 1; index < sequence.length; index++) {
    const [before, left] = sequence[index - 1];
    const [after, right] = sequence[index];
    if (after - before <= 4 && left !== right) pairs.add(left + ' ' + right);
  }
  return [...pairs];
}

function attachAliasCatalogue(corpus, catalogue, identity) {
  assert.equal(catalogue.version, 1, 'Unsupported lexical alias catalogue');
  assert.deepEqual(catalogue.corpus, identity, 'The lexical alias catalogue belongs to a different corpus');
  const documents = catalogue.documents.map(([id, hash]) => {
    const document = corpus.documents.get(id);
    assert.ok(document && document.hash === hash, `Stale English answer unit ${id}`);
    return document;
  });
  assert.equal(new Set(documents.map(document => document.id)).size, documents.length);
  const entries = (pairs, maximum) => {
    assert.ok(Array.isArray(pairs) && pairs.length <= maximum);
    return pairs.map(([index, weight]) => {
      assert.ok(Number.isInteger(index) && documents[index] && Number.isFinite(weight) && weight > 0 && weight <= 1);
      return { document: documents[index], weight };
    });
  };
  for (const [index, pairs] of Object.entries(catalogue.links)) {
    assert.ok(documents[index]);
    documents[index].aliasQuestions = entries(pairs, 7)
      .filter(item => item.document.sourceGroup !== documents[index].sourceGroup)
      .map(item => ({ document: item.document, strength: item.weight }));
  }
  corpus.aliasPostings = new Map(Object.entries(catalogue.postings).map(([term, pairs]) => [term, entries(pairs, 120)]));
  corpus.aliasPhrasePostings = new Map(Object.entries(catalogue.phrases || {}).map(([term, pairs]) => [term, entries(pairs, 60)]));
  return corpus;
}

function lookupAliasEvidence(corpus, queries) {
  const hits = new Map();
  for (const [variant, query] of queries.entries()) {
    if (!query.totalWeight) continue;
    const found = new Map();
    const strengths = Array.from({ length: query.roles.length }, () => 0);
    for (const { term, weight } of query.terms) {
      const roleIndex = query.roles.findIndex(role => role.has(term));
      if (roleIndex >= 0) strengths[roleIndex] += weight;
      for (const hit of corpus.aliasPostings?.get(term) || []) {
        const current = found.get(hit.document.id) || { support: 0, count: 0, direct: 0, parties: [0, 0] };
        found.set(hit.document.id, current);
        const qualified = weight * hit.weight;
        current.support += qualified;
        current.count++;
        if (hit.document.answer.has(term) || hit.document.question.has(term)) current.direct += qualified;
        if (roleIndex >= 0) current.parties[roleIndex] += qualified;
      }
    }
    for (const [id, evidence] of found) {
      if (evidence.count < 2 || !evidence.direct) continue;
      const factor = variant > 0 ? 0.90 : 1;
      const score = factor * evidence.support / query.totalWeight;
      const roles = strengths.length === 2 && strengths.every(Boolean)
        ? factor * Math.min(...strengths.map((strength, index) => evidence.parties[index] / strength)) : 0;
      const prior = hits.get(id) || [0, 0, 0, 0, 0];
      hits.set(id, [Math.max(prior[0], score),
        Math.max(prior[1], factor * evidence.direct / query.totalWeight), Math.max(prior[2], roles), prior[3], prior[4]]);
    }
    const phrases = new Map();
    const present = (query.phrasePairs || []).filter(phrase => corpus.aliasPhrasePostings?.has(phrase));
    for (const phrase of present) {
      const words = phrase.split(' ');
      for (const hit of corpus.aliasPhrasePostings.get(phrase)) {
        if (!words.some(word => hit.document.answer.has(word) || hit.document.question.has(word))) continue;
        const current = phrases.get(hit.document.id) || [0, 0];
        const weight = (variant > 0 ? 0.90 : 1) * hit.weight;
        phrases.set(hit.document.id, [current[0] + weight, Math.max(current[1], weight)]);
      }
    }
    for (const [id, phrase] of phrases) {
      const prior = hits.get(id) || [0, 0, 0, 0, 0];
      prior[3] = Math.max(prior[3], phrase[0] / present.length);
      prior[4] = Math.max(prior[4], phrase[1]);
      hits.set(id, prior);
    }
  }
  const strength = evidence => Math.max(evidence[0], 0.8 * evidence[3]);
  const supplemental = [...hits].filter(([, features]) => strength(features) >= 0.21)
    .sort((a, b) => strength(b[1]) - strength(a[1]) || a[0].localeCompare(b[0])).slice(0, 55).map(([id]) => id);
  return { hits, supplemental };
}

module.exports = { attachAliasCatalogue, lookupAliasEvidence, orderedPairs };
