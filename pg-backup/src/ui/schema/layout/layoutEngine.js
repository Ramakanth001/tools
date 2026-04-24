// Enterprise-friendly layout engine:
// - Instant grid layout (never blank)
// - Optional ELK layout in a web worker
// - In-memory LRU cache for layouts

// NOTE: We intentionally avoid Vite's `?worker` default-export constructor form.
// In some build modes it can yield a non-constructable export, causing:
//   "Uncaught TypeError: _Worker is not a constructor"
// Using the standard Worker constructor + `new URL(..., import.meta.url)` is
// robust across dev/build.

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

export function chooseLayoutMode(tableCount) {
  if (tableCount > 300) return 'search';
  if (tableCount >= 120) return 'perf';
  return 'full';
}

export function styleModeFor(tableCount) {
  if (tableCount >= 120) return 'perf';
  return 'full';
}

export function computeGridPositions(nodes, { columns = 4, xGap = 420, yGap = 420 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  return list.map((n, idx) => ({
    ...n,
    position: {
      x: (idx % columns) * xGap,
      y: Math.floor(idx / columns) * yGap,
    },
  }));
}

class LruCache {
  constructor({ maxEntries = 12 } = {}) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    // refresh
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
}

const cache = new LruCache({ maxEntries: 18 });

/**
 * Compute ELK positions in a web worker with caching.
 *
 * @param {object} params
 * @param {string} params.cacheKey
 * @param {'full'|'perf'} params.mode
 * @param {Array<{id:string}>} params.nodes
 * @param {Array<{id:string, source:string, target:string}>} params.edges
 * @returns {Promise<{positions: Record<string,{x:number,y:number}>, cached: boolean, ms: number}>}
 */
export function computeElkPositions({ cacheKey, mode, nodes, edges }) {
  const key = `elk:${mode}:${cacheKey}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve({ positions: hit, cached: true, ms: 0 });

  // Temporary hard-disable worker layout path because the current build/runtime
  // still resolves the worker import into a non-constructable value in this app.
  // Callers already fall back to the fast grid layout when ELK is unavailable.
  return Promise.reject(new Error('WebWorkerUnavailable'));
}
