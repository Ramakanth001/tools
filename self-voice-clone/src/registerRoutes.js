const http = require('node:http');
const https = require('node:https');

function normalizeBasePath(value) {
  const normalized = `/${String(value || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function registerSelfVoiceCloneProxy(app, {
  basePath = '/api/tools/self-voice-clone',
  target = process.env.SELF_VOICE_CLONE_API_URL || 'http://127.0.0.1:8792',
} = {}) {
  const mountPath = normalizeBasePath(basePath);
  const targetUrl = new URL(target);
  const transport = targetUrl.protocol === 'https:' ? https : http;

  app.use(mountPath, (req, res) => {
    const originalUrl = String(req.originalUrl || req.url || '/');
    const upstreamPath = originalUrl.slice(mountPath.length) || '/';
    const headers = {
      ...req.headers,
      host: targetUrl.host,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': req.protocol || 'http',
      'x-forwarded-prefix': mountPath,
    };

    const proxyRequest = transport.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers,
    }, (proxyResponse) => {
      res.status(proxyResponse.statusCode || 502);
      for (const [name, value] of Object.entries(proxyResponse.headers)) {
        if (value !== undefined) res.setHeader(name, value);
      }
      proxyResponse.pipe(res);
    });

    proxyRequest.on('error', (error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.status(502).json({
        ok: false,
        error: 'Self Voice Clone API is unavailable',
        detail: error.message,
        setup: 'Run `npm run setup:self-voice-clone`, then restart the workspace.',
      });
    });

    req.on('aborted', () => proxyRequest.destroy());
    res.on('close', () => {
      if (!res.writableEnded) proxyRequest.destroy();
    });
    req.pipe(proxyRequest);
  });

  return { basePath: mountPath, target: targetUrl.toString() };
}

module.exports = { registerSelfVoiceCloneProxy };
