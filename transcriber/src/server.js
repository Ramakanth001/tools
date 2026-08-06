const path = require('node:path');
const fsp = require('node:fs/promises');
const { requireToolDep } = require('../requireToolDep');
const { registerTranscriberRoutes } = require('./registerRoutes');
const { applyLocalApiAuth } = require('../../src/localAuth');

const express = requireToolDep('express');
const app = express();
const port = Number(process.env.PORT || 8791);
const host = process.env.HOST || '127.0.0.1';
const publicDir = path.join(__dirname, '..', 'public');
const indexPath = path.join(publicDir, 'index.html');

applyLocalApiAuth(app, { apiPrefixes: ['/api'], host, toolName: 'transcriber' });
const { service } = registerTranscriberRoutes(app, { basePath: '/api' });
app.use(express.static(publicDir));
app.get(/.*/, async (_req, res) => {
  try {
    await fsp.access(indexPath);
    res.sendFile(indexPath);
  } catch {
    res.status(503).send('UI not built. Run `npm run build` for production, or `npm run dev` for local development.');
  }
});

const server = app.listen(port, host, () => {
  const shownHost = host === '127.0.0.1' ? 'localhost' : host;
  if (!['127.0.0.1', '::1'].includes(host)) console.warn(`WARNING: transcriber is listening on non-loopback host ${host}.`);
  console.log(`transcriber running on http://${shownHost}:${port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down transcriber...`);
  await service.shutdown();
  server.close(() => process.exit(0));
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
