const express = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { z } = require('zod');

const { runBackup } = require('./backupRunner');
const { zipFolderToFile } = require('./zip');

const app = express();

app.use(express.json({ limit: '2mb' }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

/** In-memory job store (good enough for local tooling) */
const jobs = new Map();

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
  };
  jobs.set(id, job);
  return job;
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
      password: z.string().min(0).optional(),
      sslmode: z.string().min(1).default('require'),
    })
    .optional(),
  options: z
    .object({
      fullDump: z.boolean().default(true),
      schemaOnly: z.boolean().default(true),
      inventory: z.boolean().default(true),
    })
    .default({ fullDump: true, schemaOnly: true, inventory: true }),
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
      });

      job.folderPath = jobDir;
      const zipPath = path.join(BACKUPS_DIR, `${stamp}.zip`);
      jobLog(job, `Zipping to ${zipPath} ...`);
      await zipFolderToFile({ folderPath: jobDir, outZipPath: zipPath });
      job.zipPath = zipPath;
      job.status = 'done';
      jobLog(job, 'Done.');
    } catch (e) {
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
      error: job.error,
      code: job.code,
    },
  });
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

    if (job.status === 'done' || job.status === 'error') {
      res.write(`event: status\n`);
      res.write(`data: ${JSON.stringify({ status: job.status })}\n\n`);
      clearInterval(interval);
      res.end();
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
