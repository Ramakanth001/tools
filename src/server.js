const path = require('node:path');
const fsp = require('node:fs/promises');
const { createRequire } = require('node:module');

const toolRequire = createRequire(path.resolve(__dirname, '../pg-backup/package.json'));
const express = toolRequire('express');

const pgBackupManifest = require('../pg-backup/tool.manifest.js');
const mysqlToolManifest = require('../mysql-tool/tool.manifest.js');
const { registerPgBackupRoutes } = require('../pg-backup/src/registerRoutes.js');
const { registerMysqlToolRoutes } = require('../mysql-tool/src/registerRoutes.js');

const app = express();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_INDEX = path.join(PUBLIC_DIR, 'index.html');

const manifests = [pgBackupManifest, mysqlToolManifest];

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, app: 'tools', tools: manifests.map((m) => ({ id: m.id, name: m.name })) });
});

app.get('/api/tools', async (_req, res) => {
  res.json({
    ok: true,
    tools: manifests.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      apiBasePath: m.apiBasePath,
    })),
  });
});

registerPgBackupRoutes(app, { basePath: pgBackupManifest.apiBasePath });
registerMysqlToolRoutes(app, { basePath: mysqlToolManifest.apiBasePath });

app.use(express.static(PUBLIC_DIR));

app.get(/.*/, async (_req, res) => {
  try {
    await fsp.access(DIST_INDEX);
    res.sendFile(DIST_INDEX);
  } catch {
    res.status(503).send('UI not built. Run `npm run build` for production, or `npm run dev` for local development.');
  }
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`tools running on http://localhost:${port}`);
});
