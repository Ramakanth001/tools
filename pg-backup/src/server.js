const express = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { z } = require('zod');

const { runBackup } = require('./backupRunner');
const { zipFolderToFileStream } = require('./zipStream');

const app = express();

app.use(express.json({ limit: '2mb' }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

/** In-memory job store (good enough for local tooling) */
const jobs = new Map();

function listJobs({ q, limit = 50 } = {}) {
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

function createJob() {
  const id = Math.random().toString(16).slice(2) + Date.now().toString(16);
  const job = {
    id,
    createdAt: Date.now(),
    status: 'queued', // queued | running | done | error
    logs: [],
    zipPath: null,
    folderPath: null,
    error: null,
    code: null,
    stack: null,
    progress: null,
    childPids: new Set(),
    cancelRequested: false,
  };
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
  // keep memory bounded
  if (job.logs.length > 5000) job.logs.splice(0, job.logs.length - 5000);
}

const BackupRequest = z.object({
  connectionString: z.string().optional(),
  pooler: z
    .object({
      host: z.string().min(3).default('aws-1-ap-south-1.pooler.supabase.com'),
      port: z.coerce.number().int().positive().default(5432),
      user: z.string().min(3).default('postgres.cughfeafhxhumjbijlpr'),
      database: z.string().min(1).default('postgres'),
      // allow empty in schema, but we'll validate requirement below
      password: z.string().optional(),
      sslmode: z.string().min(1).default('require'),
    })
    .optional(),
  options: z
    .object({
      fullDump: z.boolean().default(true),
      schemaOnly: z.boolean().default(true),
      inventory: z.boolean().default(true),
      plainSql: z.boolean().default(false),
      roles: z.boolean().default(true),
      schemaInclude: z.string().optional(),
      schemaExclude: z.string().optional(),
      tableInclude: z.string().optional(),
      tableExclude: z.string().optional(),
    })
    .default({ fullDump: true, schemaOnly: true, inventory: true, plainSql: false, roles: true }),
});

function withSslModeRequireIfMissing(cs) {
  const s = String(cs || '').trim();
  if (!s) return s;
  if (!s.startsWith('postgres://') && !s.startsWith('postgresql://')) return s;
  if (s.includes('sslmode=')) return s;
  return s.includes('?') ? `${s}&sslmode=require` : `${s}?sslmode=require`;
}

function buildPoolerConnectionString(pooler) {
  const host = String(pooler.host || '').trim();
  const port = Number(pooler.port || 5432);
  const user = String(pooler.user || '').trim();
  const database = String(pooler.database || '').trim();
  const password = String(pooler.password || '');

  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(password);
  const encodedHost = host;
  const encodedDb = encodeURIComponent(database);

  // Always enforce TLS for pooler.
  return `postgresql://${encodedUser}:${encodedPass}@${encodedHost}:${port}/${encodedDb}?sslmode=require`;
}

const TestConnectionRequest = z.object({
  connectionString: z.string().min(10),
});

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/backup', async (req, res) => {
  const parsed = BackupRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  // Validate pooler password requirement (common supabase case).
  if (!parsed.data.connectionString && parsed.data.pooler) {
    const pw = String(parsed.data.pooler.password || '');
    if (!pw) {
      return res.status(400).json({ ok: false, error: 'Pooler password is required (or paste a full connection string)' });
    }
  }

  const connectionString = (() => {
    if (parsed.data.connectionString && parsed.data.connectionString.trim().length > 0) {
      return withSslModeRequireIfMissing(parsed.data.connectionString);
    }
    if (parsed.data.pooler) {
      return buildPoolerConnectionString(parsed.data.pooler);
    }
    return '';
  })();

  if (!connectionString || connectionString.length < 10) {
    return res.status(400).json({ ok: false, error: 'Missing connection details' });
  }

  const job = createJob();
  res.json({ ok: true, jobId: job.id });

  // run async
  (async () => {
    job.status = 'running';
    try {
      await fsp.mkdir(BACKUPS_DIR, { recursive: true });

      // Friendly preflight warning: pg tools must exist.
      jobLog(job, 'Starting backup job...');
      jobLog(job, 'Note: this tool shells out to `pg_dump` and `psql` installed on your machine.');

      const { jobDir, stamp } = await runBackup({
        connectionString,
        options: parsed.data.options,
        outDir: BACKUPS_DIR,
        log: (m) => jobLog(job, m),
        progress: (p) => {
          job.progress = { ...p, at: Date.now() };
        },
        onChild: (child) => trackChild(job, child),
        isCancelled: () => job.cancelRequested,
      });

      // Mark finishing before zipping.
      job.progress = { phase: 'zipping', percent: 96, at: Date.now() };

      job.folderPath = jobDir;
      const zipPath = path.join(BACKUPS_DIR, `${stamp}.zip`);
      jobLog(job, `Zipping to ${zipPath} ...`);
      if (job.cancelRequested) {
        job.status = 'cancelled';
        jobLog(job, 'Cancelled before zipping.');
        return;
      }
      const r = await zipFolderToFileStream({
        folderPath: jobDir,
        outZipPath: zipPath,
        onProgress: ({ bytes }) => {
          job.progress = { phase: 'zip', bytes, percent: 98, at: Date.now() };
        },
      });
      job.zipPath = zipPath;
      const st = await safeStat(zipPath);
      job.zipBytes = st?.size ?? null;
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

app.post('/api/test-connection', async (req, res) => {
  const parsed = TestConnectionRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  // We purposely do not log secrets.
  const cs = withSslModeRequireIfMissing(parsed.data.connectionString);

  // Run a tiny query using psql. This endpoint requires psql.
  const { spawn } = require('node:child_process');

  const psql = process.env.PSQL_PATH || 'psql';

  const env = {
    ...process.env,
    DATABASE_URL: cs,
  };

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(psql, [cs, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-c', 'select 1;'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve({ out, err });
        reject(new Error(err || `psql exited with code ${code}`));
      });
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      zipReady: Boolean(job.zipPath),
      zipBytes: job.zipBytes ?? null,
      cancelRequested: Boolean(job.cancelRequested),
      error: job.error,
      code: job.code,
    },
  });
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'not found' });
  if (job.status !== 'running') return res.status(409).json({ ok: false, error: `job is ${job.status}` });
  cancelJob(job);
  jobLog(job, 'Cancel requested. Sending SIGTERM to child processes...');
  res.json({ ok: true });
});

app.get('/api/jobs', async (req, res) => {
  const q = req.query.q;
  const limit = req.query.limit;
  const list = listJobs({ q, limit });
  res.json({
    ok: true,
    jobs: list.map((j) => ({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt,
      zipReady: Boolean(j.zipPath),
      zipBytes: j.zipBytes ?? null,
      error: j.error || null,
    })),
  });
});

app.post('/api/jobs/:id/delete', async (req, res) => {
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

app.post('/api/cleanup', async (req, res) => {
  const schema = z.object({
    days: z.coerce.number().int().positive().default(14),
    keep: z.coerce.number().int().positive().default(50),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const days = parsed.data.days;
  const keep = parsed.data.keep;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = Array.from(jobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const keepIds = new Set(all.slice(0, keep).map((j) => j.id));
  let deleted = 0;
  for (const j of all) {
    if (j.status === 'running') continue;
    const tooOld = (j.createdAt || 0) < cutoff;
    const overKeep = !keepIds.has(j.id);
    if (!tooOld && !overKeep) continue;
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

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let idx = 0;
  const interval = setInterval(() => {
    while (idx < job.logs.length) {
      const line = job.logs[idx++];
      res.write(`event: log\n`);
      res.write(`data: ${JSON.stringify(line)}\n\n`);
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

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  if (!job.zipPath) return res.status(409).json({ ok: false, error: 'zip not ready' });
  res.download(job.zipPath);
});

app.use(express.static(PUBLIC_DIR));

// Express 5 no longer accepts "*" as a route. Use a regex catch-all.
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`pg-backup running on http://localhost:${port}`);
});
