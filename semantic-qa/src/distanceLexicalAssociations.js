function increment(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function buildLexicalAssociations(documents) {
  const sources = new Map();
  for (const document of documents.values()) {
    let group = sources.get(document.sourceId);
    if (!group) sources.set(document.sourceId, group = []);
    group.push(document);
  }
  const questionCounts = new Map();
  const answerCounts = new Map();
  for (const group of sources.values()) {
    const questions = new Set();
    const answers = new Set();
    for (const doc of group) {
      if (doc.questionText?.includes('?')) for (const term of doc.question.keys()) questions.add(term);
      for (const term of doc.answer.keys()) answers.add(term);
    }
    for (const term of questions) increment(questionCounts, term);
    for (const term of answers) increment(answerCounts, term);
  }

  const answerTerms = [...answerCounts.keys()];
  const identifiers = new Map(answerTerms.map((word, index) => [word, index]));
  const queryTerms = [...questionCounts.keys()].filter(term => questionCounts.get(term) >= 5
    && questionCounts.get(term) <= sources.size * 0.25);
  const queryId = new Map(queryTerms.map((term, index) => [term, index]));
  const pairCounts = queryTerms.map(() => new Map());
  for (const group of sources.values()) {
    const seen = new Set();
    for (const doc of group) {
      if (!doc.questionText?.includes('?')) continue;
      const signposts = [...doc.question.keys()].filter(term => queryId.has(term))
        .sort((a, b) => questionCounts.get(a) - questionCounts.get(b)).slice(0, 25);
      const eligible = [...doc.answer.keys()].filter(term => {
        const count = answerCounts.get(term);
        return !doc.question.has(term) && count >= 5 && count < sources.size * 0.30;
      }).sort((a, b) => answerCounts.get(a) - answerCounts.get(b)).slice(0, 48);
      for (const query of signposts) {
        const question = queryId.get(query);
        for (const term of eligible) {
          const answer = identifiers.get(term);
          const key = question * answerTerms.length + answer;
          if (!seen.has(key)) {
            seen.add(key);
            increment(pairCounts[question], answer);
          }
        }
      }
    }
  }

  const result = new Map();
  for (const [id, pairs] of pairCounts.entries()) {
    const query = queryTerms[id];
    const related = [...pairs].flatMap(([answer, support]) => {
      const term = answerTerms[answer];
      const conditional = support / questionCounts.get(query);
      if (support < 4 || conditional < 0.035) return [];
      const background = answerCounts.get(term) / sources.size;
      const lift = conditional / background;
      if (lift < 2.5) return [];
      return [{ term, weight: Math.log(lift) * Math.sqrt(conditional) * (support / (support + 6)) }];
    }).sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term)).slice(0, 8);
    if (related.length) result.set(query, related);
  }
  return result;
}

module.exports = { buildLexicalAssociations };
