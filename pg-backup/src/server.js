const path = require('node:path');
const fsp = require('node:fs/promises');
const express = require('express');
const { registerPgBackupRoutes } = require('./registerRoutes');

const app = express();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VITE_DIST_INDEX = path.join(PUBLIC_DIR, 'index.html');
registerPgBackupRoutes(app, { basePath: '/api' });

app.use(express.static(PUBLIC_DIR));

// Legacy vendor routes removed: schema visualizer is now bundled by Vite (React Flow + elkjs).

// SPA fallback. In dev, Vite serves the UI; in prod, we serve the built index.html.
// Express 5 no longer accepts "*" as a route. Use a regex catch-all.
app.get(/.*/, async (_req, res) => {
  try {
    // If build hasn't been run yet, give a helpful error instead of hanging.
    await fsp.access(VITE_DIST_INDEX);
    res.sendFile(VITE_DIST_INDEX);
  } catch {
    res.status(503).send('UI not built. Run `npm run build` for production, or `npm run dev` for local development.');
  }
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`pg-backup running on http://localhost:${port}`);
});
