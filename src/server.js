const path = require('node:path');
const fsp = require('node:fs/promises');
const { createRequire } = require('node:module');

const toolRequire = createRequire(path.resolve(__dirname, '../package.json'));
const express = toolRequire('express');

const pgBackupManifest = require('../pg-backup/tool.manifest.js');
const mysqlToolManifest = require('../mysql-tool/tool.manifest.js');
const mysqlPgMigrateManifest = require('../mysql-pg-migrate/tool.manifest.js');
const semanticQaManifest = require('../semantic-qa/tool.manifest.js');
const gptManifest = require('../gpt/tool.manifest.js');
const transcriberManifest = require('../transcriber/tool.manifest.js');
const selfVoiceCloneManifest = require('../self-voice-clone/tool.manifest.js');
const { registerPgBackupRoutes } = require('../pg-backup/src/registerRoutes.js');
const { registerMysqlToolRoutes } = require('../mysql-tool/src/registerRoutes.js');
const { registerMysqlPgMigrateRoutes } = require('../mysql-pg-migrate/src/registerRoutes.js');
const { registerSemanticQaRoutes } = require('../semantic-qa/src/registerRoutes.js');
const { registerGptRoutes } = require('../gpt/src/registerRoutes.js');
const { registerTranscriberRoutes } = require('../transcriber/src/registerRoutes.js');
const { registerSelfVoiceCloneProxy } = require('../self-voice-clone/src/registerRoutes.js');
const { applyLocalApiAuth } = require('./localAuth');
const { createSetupChecker } = require('./setupChecks');

const app = express();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_INDEX = path.join(PUBLIC_DIR, 'index.html');

const manifests = [pgBackupManifest, mysqlToolManifest, mysqlPgMigrateManifest, semanticQaManifest, gptManifest, transcriberManifest, selfVoiceCloneManifest];
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const checkToolSetup = createSetupChecker({
  workspaceDir: path.join(__dirname, '..'),
  toolIds: manifests.map((manifest) => manifest.id),
});

applyLocalApiAuth(app, { apiPrefixes: ['/api'], host, toolName: 'tools' });

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

app.get('/api/tools/:toolId/setup-check', async (req, res) => {
  try {
    res.json(await checkToolSetup(req.params.toolId));
  } catch (error) {
    const status = error.code === 'UNKNOWN_TOOL' ? 404 : 500;
    res.status(status).json({ ok: false, error: error.message || 'Setup check failed' });
  }
});

registerPgBackupRoutes(app, { basePath: pgBackupManifest.apiBasePath });
registerMysqlToolRoutes(app, { basePath: mysqlToolManifest.apiBasePath });
registerMysqlPgMigrateRoutes(app, { basePath: mysqlPgMigrateManifest.apiBasePath });
registerSemanticQaRoutes(app, { basePath: semanticQaManifest.apiBasePath });
registerGptRoutes(app, { basePath: gptManifest.apiBasePath });
registerTranscriberRoutes(app, { basePath: transcriberManifest.apiBasePath });
registerSelfVoiceCloneProxy(app, { basePath: selfVoiceCloneManifest.apiBasePath });

app.use(express.static(PUBLIC_DIR));

app.get(/.*/, async (_req, res) => {
  try {
    await fsp.access(DIST_INDEX);
    res.sendFile(DIST_INDEX);
  } catch {
    res.status(503).send('UI not built. Run `npm run build` for production, or `npm run dev` for local development.');
  }
});

const server = app.listen(port, host, () => {
  const shownHost = host === '127.0.0.1' ? 'localhost' : host;
  if (host !== '127.0.0.1' && host !== '::1') {
    console.warn(`WARNING: tools is listening on non-loopback host ${host}.`);
  }
  console.log(`tools running on http://${shownHost}:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down tools...`);
  server.close(() => process.exit(0));
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
