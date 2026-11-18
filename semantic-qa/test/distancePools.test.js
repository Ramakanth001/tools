const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDistancePoolLease } = require('../src/distancePools');

function fixture(options) {
  const pools = [];
  const lease = createDistancePoolLease(() => {
    const pool = new EventEmitter();
    pool.ended = 0;
    pool.end = async () => { pool.ended++; };
    pools.push(pool);
    return pool;
  }, options);
  return { lease, pools };
}

test('distance requests reuse a pool for identical credentials and isolate different credentials', async () => {
  const { lease, pools } = fixture();
  const config = { host: 'localhost', database: 'corpus', user: 'reader', password: 'once' };
  const first = await lease(config, pool => pool);
  const second = await lease({ ...config }, pool => pool);
  const other = await lease({ ...config, password: 'rotated' }, pool => pool);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(pools.length, 2);
  assert.equal(first.ended, 0);
});

test('an active distance pool is not closed when another connection is requested', async () => {
  const { lease, pools } = fixture({ capacity: 1 });
  await lease({ database: 'annual' }, async active => {
    await lease({ database: 'archive' }, pool => assert.notEqual(pool, active));
    assert.equal(active.ended, 0);
    assert.equal(pools[1].ended, 1);
  });
  await lease({ database: 'archive' }, () => {});
  assert.equal(pools[0].ended, 1);
});

test('a failed distance pool retires after its current requests finish', async () => {
  const { lease, pools } = fixture();
  const config = { database: 'corpus' };
  await lease(config, async first => {
    first.emit('error', new Error('idle socket ended'));
    assert.equal(first.ended, 0);
    await lease(config, second => assert.notEqual(second, first));
  });
  assert.equal(pools[0].ended, 1);
});
