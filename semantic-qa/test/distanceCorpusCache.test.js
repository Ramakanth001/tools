const assert = require('node:assert/strict');
const test = require('node:test');
const { createDistanceCorpusCache } = require('../src/distanceCorpusCache');

test('cache expiration checks the corpus version and rebuilds only after its data changes', async () => {
  let version = 'first';
  let clock = 0;
  let loads = 0;
  const pool = { async query() { return { rows: [{ answer_version: version, record_version: 'r1' }] }; } };
  const cache = createDistanceCorpusCache(async () => ({ load: ++loads }), { now: () => clock });
  const [initial, parallel] = await Promise.all([cache.get(pool), cache.get(pool)]);
  assert.equal(initial, parallel);
  clock += 5 * 60 * 1000;
  assert.equal(await cache.get(pool), initial);
  version = 'second';
  clock += 5 * 60 * 1000;
  assert.deepEqual(await cache.get(pool), { load: 2 });
});

test('a corpus that changes during a rebuild is checked again on the next request', async () => {
  let generation = 1;
  let reads = 0;
  const pool = { async query() { return { rows: [{ answer_version: generation, record_version: 1 }] }; } };
  const cache = createDistanceCorpusCache(async () => {
    if (++reads === 1) generation++;
    return generation;
  });
  assert.equal(await cache.get(pool), 2);
  assert.equal(await cache.get(pool), 2);
  assert.equal(reads, 2);
});
