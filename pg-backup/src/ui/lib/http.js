import { resolveApiUrl } from './runtime.js';

export async function api(path, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('Request timeout')), timeoutMs);
  try {
    const resp = await fetch(resolveApiUrl(path), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      const msg = json.error ? (typeof json.error === 'string' ? json.error : JSON.stringify(json.error)) : resp.statusText;
      const e = new Error(msg || 'Request failed');
      e.status = resp.status;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}
