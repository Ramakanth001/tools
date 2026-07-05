import { resolveApiUrl } from './runtime.js';

const AUTH_STORAGE_KEY = 'tools.authToken';

export function getAuthToken() {
  const tokenFromUrl = new URLSearchParams(window.location.search).get('token') || '';
  if (tokenFromUrl) localStorage.setItem(AUTH_STORAGE_KEY, tokenFromUrl);
  return tokenFromUrl || localStorage.getItem(AUTH_STORAGE_KEY) || '';
}

export function getAuthHeaders() {
  const token = getAuthToken();
  return token ? { 'x-tools-auth': token } : {};
}

export function withAuthQuery(url) {
  const token = getAuthToken();
  if (!token) return url;
  const next = new URL(url, window.location.origin);
  next.searchParams.set('token', token);
  return next.toString();
}

export async function api(path, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('Request timeout')), timeoutMs);
  try {
    const resp = await fetch(resolveApiUrl(path), {
      method,
      headers: { ...getAuthHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
