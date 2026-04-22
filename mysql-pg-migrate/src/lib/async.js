async function runWithConcurrency(items, worker, { concurrency = 1 } = {}) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let index = 0;

  async function next() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

module.exports = { runWithConcurrency };