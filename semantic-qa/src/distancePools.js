const { createHash } = require('node:crypto');

function createDistancePoolLease(createPool, { capacity = 4, idleMs = 60000 } = {}) {
  const entries = new Map();
  const dispose = entry => {
    if (entry.closing) return entry.closing;
    entry.closing = Promise.resolve().then(() => entry.pool.end()).catch(() => undefined);
    return entry.closing;
  };
  const retire = (key, entry) => {
    clearTimeout(entry.timer);
    if (entries.get(key) === entry) entries.delete(key);
    entry.retired = true;
    if (entry.users === 0) void dispose(entry);
  };

  return async function withDistancePool(config, callback) {
    // Exact configuration identity includes role and credentials. Keep only
    // a digest in the lease map so connections cannot share a cached corpus
    // across credentials, TLS settings or a different database.
    const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= capacity) {
        const idle = [...entries].find(([, candidate]) => candidate.users === 0);
        if (idle) retire(...idle);
      }
      const pool = createPool(config);
      if (entries.size >= capacity) {
        pool.on('error', () => {});
        try { return await callback(pool); }
        finally { await pool.end().catch(() => undefined); }
      }
      entry = { pool, users: 0, retired: false };
      entries.set(key, entry);
      pool.on('error', () => retire(key, entry));
    }
    clearTimeout(entry.timer);
    entry.users++;
    try {
      return await callback(entry.pool);
    } finally {
      entry.users--;
      if (entry.users === 0) {
        if (entry.retired) {
          await dispose(entry);
        } else {
          entry.timer = setTimeout(() => retire(key, entry), idleMs);
          entry.timer.unref();
        }
      }
    }
  };
}

module.exports = { createDistancePoolLease };
