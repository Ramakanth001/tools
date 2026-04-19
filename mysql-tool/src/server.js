const path = require('node:path');
const fsp = require('node:fs/promises');

const { requireToolDep } = require('../requireToolDep');
const express = requireToolDep('express');
const { registerMysqlToolRoutes } = require('./registerRoutes');

const app = express();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_INDEX = path.join(PUBLIC_DIR, 'index.html');

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

const port = Number(process.env.PORT || 8788);
app.listen(port, () => {
  console.log(`mysql-tool running on http://localhost:${port}`);
});