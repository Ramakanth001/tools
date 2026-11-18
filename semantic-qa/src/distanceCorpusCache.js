const CACHE_TTL_MS = 5 * 60 * 1000;

async function corpusVersion(pool) {
  const { rows: [version] } = await pool.query(`
    SELECT
      (SELECT md5(string_agg(answer_unit_id || ':' || xmin::text, ',' ORDER BY answer_unit_id))
       FROM semantic_qa.answer_units) AS answer_version,
      (SELECT md5(string_agg(source_id || ':' || xmin::text, ',' ORDER BY source_id))
       FROM semantic_qa.records) AS record_version
  `);
  return version && Object.hasOwn(version, 'answer_version') && Object.hasOwn(version, 'record_version')
    ? JSON.stringify([version.answer_version, version.record_version]) : null;
}

function createDistanceCorpusCache(load, { now = Date.now } = {}) {
  let entries = new WeakMap();
  function get(pool) {
    const previous = entries.get(pool);
    if (previous?.expiresAt > now()) return previous.promise;
    const entry = { expiresAt: Infinity, version: null };
    entry.promise = (async () => {
      const version = await corpusVersion(pool).catch(() => null);
      if (version !== null && version === previous?.version) {
        entry.version = version;
        entry.expiresAt = now() + CACHE_TTL_MS;
        return previous.promise;
      }
      const index = await load(pool);
      const confirmed = version === null ? null : await corpusVersion(pool).catch(() => null);
      entry.version = confirmed === version ? confirmed : null;
      entry.expiresAt = confirmed === version ? now() + CACHE_TTL_MS : now();
      return index;
    })().catch(error => {
      if (entries.get(pool) === entry) entries.delete(pool);
      throw error;
    });
    entries.set(pool, entry);
    return entry.promise;
  }
  return { get, clear() { entries = new WeakMap(); } };
}

module.exports = { createDistanceCorpusCache };
