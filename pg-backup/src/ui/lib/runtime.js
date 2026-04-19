const DEFAULT_RUNTIME = {
  toolId: 'pg-backup',
  apiBasePath: '/api',
  homePath: '/',
  logsPath: '/logs',
  storagePrefix: 'pgbackup',
};

let runtime = { ...DEFAULT_RUNTIME };

function trimTrailingSlash(s) {
  const v = String(s || '');
  if (!v || v === '/') return v || '/';
  return v.replace(/\/+$/, '');
}

function ensureLeadingSlash(s) {
  const v = String(s || '');
  if (!v) return '/';
  return v.startsWith('/') ? v : `/${v}`;
}

function joinPaths(base, next) {
  const a = trimTrailingSlash(ensureLeadingSlash(base || '/'));
  const b = String(next || '');
  if (!b || b === '/') return a || '/';
  const tail = b.startsWith('/') ? b : `/${b}`;
  return `${a}${tail}`.replace(/\/+/g, '/');
}

export function setPgBackupRuntime(next = {}) {
  runtime = {
    ...DEFAULT_RUNTIME,
    ...next,
  };
  return runtime;
}

export function getPgBackupRuntime() {
  return runtime;
}

export function resolveApiUrl(path = '') {
  const input = String(path || '');
  if (!input) return runtime.apiBasePath;
  if (/^https?:\/\//i.test(input)) return input;
  if (input.startsWith('/api/')) return input;
  return joinPaths(runtime.apiBasePath, input);
}

export function getStorageKey(name) {
  return `${runtime.storagePrefix}.${String(name || '').replace(/^\.+/, '')}`;
}

export function isLogsPath(pathname = '') {
  return trimTrailingSlash(ensureLeadingSlash(pathname || '/')) === trimTrailingSlash(ensureLeadingSlash(runtime.logsPath || '/logs'));
}

export function getLogsUrl(jobId = '') {
  const base = ensureLeadingSlash(runtime.logsPath || '/logs');
  if (!jobId) return base;
  return `${base}?jobId=${encodeURIComponent(jobId)}`;
}

export function getHomeUrl() {
  return ensureLeadingSlash(runtime.homePath || '/');
}
