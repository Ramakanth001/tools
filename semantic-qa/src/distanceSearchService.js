const { searchDistanceCorpus } = require('./distanceSearch');
const { createLexicalRanker } = require('./distanceLexicalRanker');
const model = require('../data/distance-english-lexical-model.json');

const lexicalRanker = createLexicalRanker({ ...model, protectStrongQuestion: true });
const englishOptions = {
  corpusGroundedEnglish: true,
  experimentalSingleUnitTitles: true,
  experimentalEnglishBodies: true,
  experimentalEnglishPassages: true,
  lexicalRanker,
};

function createDistanceSearchService({ search = searchDistanceCorpus, useEnglish = true } = {}) {
  return {
    async searchDistanceCorpus(pool, request) {
      if (pool && useEnglish) {
        try {
          return await search(pool, { ...request, ...englishOptions });
        } catch {
          // The expanded path depends on additional corpus fields. Try classic
          // retrieval for older indexes and transient expansion failures.
        }
      }
      return search(pool, request);
    },
  };
}

module.exports = { createDistanceSearchService };
