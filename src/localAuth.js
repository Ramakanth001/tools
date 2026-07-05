function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

function getConfiguredAuthToken() {
  return String(process.env.TOOLS_AUTH_TOKEN || process.env.TOOL_AUTH_TOKEN || '').trim();
}

function extractRequestToken(req) {
  const auth = String(req.get('authorization') || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (typeof req.query?.token === 'string') return req.query.token.trim();
  return String(req.get('x-tools-auth') || '').trim();
}

function applyLocalApiAuth(app, { apiPrefixes = ['/api'], host = '127.0.0.1', toolName = 'tool' } = {}) {
  const token = getConfiguredAuthToken();
  if (!isLoopbackHost(host) && !token) {
    throw new Error(`${toolName} refuses non-loopback host ${host} without TOOLS_AUTH_TOKEN`);
  }
  if (!token) return { enabled: false };

  app.use((req, res, next) => {
    const protectedPath = apiPrefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
    if (!protectedPath || req.method === 'OPTIONS') return next();
    if (extractRequestToken(req) === token) return next();
    return res.status(401).json({ ok: false, error: 'Missing or invalid tools auth token' });
  });
  return { enabled: true };
}

module.exports = { applyLocalApiAuth, getConfiguredAuthToken, isLoopbackHost };
