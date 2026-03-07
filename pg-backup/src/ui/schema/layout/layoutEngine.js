// Enterprise-friendly layout engine:
// - Instant grid layout (never blank)
// - Optional ELK layout in a web worker
// - In-memory LRU cache for layouts

import ElkWorker from './elk.worker.js?worker';

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

let workerSingleton = null;
function getWorker() {
  if (workerSingleton) return workerSingleton;
  workerSingleton = new ElkWorker();
  return workerSingleton;
}

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

  const worker = getWorker();
  const id = Math.random().toString(16).slice(2) + Date.now().toString(16);
  const t0 = now();

  return new Promise((resolve, reject) => {
    const onMessage = (evt) => {
      const msg = evt.data;
      if (!msg || msg.id !== id) return;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);

      if (!msg.ok) return reject(new Error(msg.error || 'ELK layout failed'));
      const positions = msg.positions || {};
      cache.set(key, positions);
      resolve({ positions, cached: false, ms: now() - t0 });
    };

    const onError = (e) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(e);
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    worker.postMessage({
      id,
      mode,
      nodes: (nodes || []).map((n) => ({ id: n.id, width: 360, height: 320 })),
      edges: (edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target })),
    });
  });
}
