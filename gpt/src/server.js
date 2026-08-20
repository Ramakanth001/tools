const path = require('node:path');
const fsp = require('node:fs/promises');
const { requireToolDep } = require('../requireToolDep');
const { registerGptRoutes } = require('./registerRoutes');
const { applyLocalApiAuth } = require('../../src/localAuth');

const express = requireToolDep('express');
const app = express();
const port = Number(process.env.PORT || 8793);
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host.toLocaleLowerCase())) {
  throw new Error('GPT must listen on a loopback host (127.0.0.1, localhost, or ::1).');
}
const publicDir = path.join(__dirname, '..', 'public');
const indexPath = path.join(publicDir, 'index.html');

applyLocalApiAuth(app, { apiPrefixes: ['/api'], host, toolName: 'gpt' });
registerGptRoutes(app, { basePath: '/api' });
app.use(express.static(publicDir));
app.get(/.*/, async (_req, res) => {
  try { await fsp.access(indexPath); res.sendFile(indexPath); }
  catch { res.status(503).send('GPT UI not built. Run `npm run build:gpt`.'); }
});

const server = app.listen(port, host, () => {
  const shownHost = host === '127.0.0.1' ? 'localhost' : host;
  console.log(`GPT running on http://${shownHost}:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down GPT...`);
  server.close(() => process.exit(0));
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
