const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { requireToolDep } = require('../requireToolDep');

const express = requireToolDep('express');
const { z } = requireToolDep('zod');

const { runBackup, buildMysqlArgs } = require('./backupRunner');
const { zipFolderToFileStream } = require('./zipStream');

const BACKUPS_DIR = path.join(__dirname, '..', 'backups');
const PROFILES_JSON = path.join(__dirname, '..', 'mysqltool.profiles.json');

function listJobsFromStore(jobs, { q, limit = 50 } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const all = Array.from(jobs.values());
  all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const filtered = query ? all.filter((j) => String(j.id).toLowerCase().includes(query)) : all;
  return filtered.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

async function safeStat(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

function createJob(jobs) {
  const id = Math.random().toString(16).slice(2) + Date.now().toString(16);
  const job = { id, createdAt: Date.now(), status: 'queued', logs: [], zipPath: null, folderPath: null, error: null, code: null, stack: null, progress: null, childPids: new Set(), cancelRequested: false };
  jobs.set(id, job);
  return job;
}

function trackChild(job, child) {
  if (!child || typeof child.pid !== 'number') return;
  job.childPids.add(child.pid);
  child.on('close', () => job.childPids.delete(child.pid));
}

function cancelJob(job) {
  job.cancelRequested = true;
  for (const pid of Array.from(job.childPids)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
}

function jobLog(job, msg) {
  const line = `[${new Date().toISOString()}] ${String(msg).trimEnd()}`;
  job.logs.push(line);
  if (job.logs.length > 5000) job.logs.splice(0, job.logs.length - 5000);
}

const ConnectionSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive().default(3306),
  user: z.string().min(1),
  password: z.string().optional(),
  database: z.string().min(1),
  sslMode: z.string().default('PREFERRED'),
  connectionString: z.string().optional(),
});

const BackupRequest = z.object({
  connection: ConnectionSchema,
  options: z.object({
    fullDump: z.boolean().default(true),
    schemaOnly: z.boolean().default(true),
    inventory: z.boolean().default(true),
    tableInclude: z.string().optional(),
    tableExclude: z.string().optional(),
  }).default({ fullDump: true, schemaOnly: true, inventory: true }),
});

const TestConnectionRequest = z.object({ connection: ConnectionSchema });

async function loadProfilesTemplate() {
  try {
    const raw = await fsp.readFile(PROFILES_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensurePassword(connection, res) {
  if (String(connection.password || '').length > 0) return true;
  res.status(400).json({ ok: false, error: 'Password is required for MySQL connections' });
  return false;
}

function registerMysqlToolRoutes(app, { basePath = '/api/tools/mysql-tool' } = {}) {
  const router = express.Router();
  const jobs = new Map();
  router.use(express.json({ limit: '2mb' }));

  router.get('/health', async (_req, res) => {
    res.json({ ok: true, tool: 'mysql-tool' });
  });

  router.get('/profiles-template', async (_req, res) => {
    res.json({ ok: true, profiles: await loadProfilesTemplate() });
  });

  router.post('/test-connection', async (req, res) => {
    const parsed = TestConnectionRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    if (!ensurePassword(parsed.data.connection, res)) return;
    const mysqlCmd = process.env.MYSQL_PATH || 'mysql';
    const env = { ...process.env, MYSQL_PWD: parsed.data.connection.password || process.env.MYSQL_PWD || '' };
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(mysqlCmd, [...buildMysqlArgs(parsed.data.connection, { includePassword: false }), `--database=${parsed.data.connection.database}`, '--batch', '--raw', '-e', 'select 1;'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `mysql exited with code ${code}`)));
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  router.post('/backup', async (req, res) => {
    const parsed = BackupRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    if (!ensurePassword(parsed.data.connection, res)) return;
    const job = createJob(jobs);
    res.json({ ok: true, jobId: job.id });

    (async () => {
      job.status = 'running';
      try {
        await fsp.mkdir(BACKUPS_DIR, { recursive: true });
        jobLog(job, 'Starting MySQL backup job...');
        jobLog(job, 'Note: this tool shells out to `mysqldump` and `mysql` installed on your machine.');
        const { jobDir, stamp } = await runBackup({
          connection: parsed.data.connection,
          options: parsed.data.options,
          outDir: BACKUPS_DIR,
          log: (m) => jobLog(job, m),
          progress: (p) => { job.progress = { ...p, at: Date.now() }; },
          onChild: (child) => trackChild(job, child),
          isCancelled: () => job.cancelRequested,
        });

        job.progress = { phase: 'zipping', percent: 96, at: Date.now() };
        job.folderPath = jobDir;
        const zipPath = path.join(BACKUPS_DIR, `${stamp}.zip`);
        jobLog(job, `Zipping to ${zipPath} ...`);
        if (job.cancelRequested) {
          job.status = 'cancelled';
          jobLog(job, 'Cancelled before zipping.');
          return;
        }
        await zipFolderToFileStream({ folderPath: jobDir, outZipPath: zipPath, onProgress: ({ bytes }) => { job.progress = { phase: 'zip', bytes, percent: 98, at: Date.now() }; } });
        job.zipPath = zipPath;
        job.zipBytes = (await safeStat(zipPath))?.size ?? null;
        if (job.cancelRequested) {
          job.status = 'cancelled';
          jobLog(job, 'Cancelled.');
        } else {
          job.status = 'done';
          jobLog(job, 'Done.');
        }
      } catch (e) {
        if (job.cancelRequested || e?.code === 'JOB_CANCELLED') {
          job.status = 'cancelled';
          jobLog(job, 'Cancelled.');
          return;
        }
        job.status = 'error';
        job.error = e?.message || String(e);
        job.stack = e?.stack || null;
        job.code = e?.code || null;
        jobLog(job, `ERROR: ${job.error}`);
        if (job.code) jobLog(job, `ERROR_CODE: ${job.code}`);
      }
    })();
  });

  router.get('/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, job: { id: job.id, status: job.status, createdAt: job.createdAt, zipReady: Boolean(job.zipPath), zipBytes: job.zipBytes ?? null, cancelRequested: Boolean(job.cancelRequested), error: job.error, code: job.code } });
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });
    if (job.status !== 'running') return res.status(409).json({ ok: false, error: `job is ${job.status}` });
    cancelJob(job);
    jobLog(job, 'Cancel requested. Sending SIGTERM to child processes...');
    res.json({ ok: true });
  });

  router.get('/jobs', async (req, res) => {
    const list = listJobsFromStore(jobs, { q: req.query.q, limit: req.query.limit });
    res.json({ ok: true, jobs: list.map((j) => ({ id: j.id, status: j.status, createdAt: j.createdAt, zipReady: Boolean(j.zipPath), zipBytes: j.zipBytes ?? null, error: j.error || null })) });
  });

  router.post('/jobs/:id/delete', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });
    if (job.status === 'running') return res.status(409).json({ ok: false, error: 'job is running' });
    try {
      if (job.zipPath) await rmrf(job.zipPath);
      if (job.folderPath) await rmrf(job.folderPath);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
    jobs.delete(job.id);
    res.json({ ok: true });
  });

  router.post('/cleanup', async (req, res) => {
    const schema = z.object({ days: z.coerce.number().int().positive().default(14), keep: z.coerce.number().int().positive().default(50) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const cutoff = Date.now() - parsed.data.days * 24 * 60 * 60 * 1000;
    const all = Array.from(jobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const keepIds = new Set(all.slice(0, parsed.data.keep).map((j) => j.id));
    let deleted = 0;
    for (const j of all) {
      if (j.status === 'running') continue;
      if ((j.createdAt || 0) >= cutoff && keepIds.has(j.id)) continue;
      try {
        if (j.zipPath) await rmrf(j.zipPath);
        if (j.folderPath) await rmrf(j.folderPath);
      } catch {
        // ignore cleanup errors
      }
      jobs.delete(j.id);
      deleted++;
    }
    res.json({ ok: true, deleted });
  });

  router.get('/jobs/:id/events', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let idx = 0;
    const interval = setInterval(() => {
      while (idx < job.logs.length) {
        res.write(`event: log\n`);
        res.write(`data: ${JSON.stringify(job.logs[idx++])}\n\n`);
      }
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        if (job.progress) {
          res.write(`event: progress\n`);
          res.write(`data: ${JSON.stringify(job.progress)}\n\n`);
        }
        res.write(`event: status\n`);
        res.write(`data: ${JSON.stringify({ status: job.status })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }
      if (job.status === 'running' && job.progress) {
        res.write(`event: progress\n`);
        res.write(`data: ${JSON.stringify(job.progress)}\n\n`);
      }
    }, 400);
    req.on('close', () => clearInterval(interval));
  });

  router.get('/jobs/:id/download', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).end();
    if (!job.zipPath) return res.status(409).json({ ok: false, error: 'zip not ready' });
    res.download(job.zipPath);
  });

  app.use(basePath, router);
  return { router, jobs };
}

module.exports = { registerMysqlToolRoutes };