const assert = require('node:assert/strict');
const test = require('node:test');
const { createDistanceSearchService } = require('../src/distanceSearchService');

test('the live distance service uses the guarded English profile on the PostgreSQL pool', async () => {
  const pool = {};
  const service = createDistanceSearchService({ async search(actualPool, request) {
    assert.equal(actualPool, pool);
    assert.equal(request.query, 'Should I prepare for the examination next week?');
    assert.equal(request.limit, 35);
    assert.equal(request.corpusGroundedEnglish, true);
    assert.equal(request.experimentalEnglishPassages, true);
    assert.equal(typeof request.lexicalRanker.rank, 'function');
    return { matches: [{ answerUnitId: 'source:1' }] };
  } });
  assert.deepEqual(await service.searchDistanceCorpus(pool, {
    query: 'Should I prepare for the examination next week?', limit: 35,
  }), { matches: [{ answerUnitId: 'source:1' }] });
});

test('unavailable expansion retries the original request through classic retrieval', async () => {
  const original = { query: 'Gayatri Mantra', limit: 10 };
  const requests = [];
  const service = createDistanceSearchService({ async search(_pool, request) {
    requests.push(request);
    if (request.corpusGroundedEnglish) throw new Error('Additional index fields are unavailable');
    return { matches: [] };
  } });
  await service.searchDistanceCorpus({}, original);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], original);
});

test('classic mode preserves the original search request directly', async () => {
  const original = { query: 'Gayatri Mantra', limit: 10 };
  const service = createDistanceSearchService({ useEnglish: false, async search(_pool, request) {
    assert.equal(request, original);
    return { matches: [] };
  } });
  await service.searchDistanceCorpus({}, original);
});
