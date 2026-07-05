const path = require('node:path');
const fsp = require('node:fs/promises');

const { requireToolDep } = require('../requireToolDep');
const express = requireToolDep('express');
const { registerMysqlToolRoutes } = require('./registerRoutes');
const { applyLocalApiAuth } = require('../../src/localAuth');

const app = express();
const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_INDEX = path.join(PUBLIC_DIR, 'index.html');

applyLocalApiAuth(app, { apiPrefixes: ['/api'], host, toolName: 'mysql-tool' });
registerMysqlToolRoutes(app, { basePath: '/api' });

app.use(express.static(PUBLIC_DIR));

app.get(/.*/, async (_req, res) => {
  try {
    await fsp.access(DIST_INDEX);
    res.sendFile(DIST_INDEX);
  } catch {
    res.status(503).send('UI not built. Run `npm run build` for production, or `npm run dev` for local development.');
  }
});

app.listen(port, host, () => {
  const shownHost = host === '127.0.0.1' ? 'localhost' : host;
  if (host !== '127.0.0.1' && host !== '::1') {
    console.warn(`WARNING: mysql-tool is listening on non-loopback host ${host}.`);
  }
  console.log(`mysql-tool running on http://${shownHost}:${port}`);
});
