const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { requireToolDep } = require('../requireToolDep');
const { createTranscriberRunner } = require('./runner');
const { createTranscriberJobStore } = require('./jobStore');

const express = requireToolDep('express');
const multer = requireToolDep('multer');
const { z } = requireToolDep('zod');

const TOOL_DIR = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(TOOL_DIR, 'data');
const MODELS = ['tiny', 'base', 'small', 'medium', 'turbo'];
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted']);

function configuredUploadBytes() {
  const megabytes = Number(process.env.TRANSCRIBER_MAX_UPLOAD_MB || 2048);
  return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : 2048) * 1024 * 1024;
}

const JobOptions = z.object({
  model: z.enum(MODELS).default('small'),
  language: z.string().trim().toLowerCase().default('auto').refine(
    (value) => value === 'auto' || /^[a-z]{2,3}$/.test(value),
    'Language must be auto or a two/three-letter lowercase code'
  ),
});

function nowLog(message) {
  return `[${new Date().toISOString()}] ${String(message).trim()}`;
}

function safeOriginalName(name) {
  return path.basename(String(name || 'media')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'media';
}

function publicJob(job, { includeLogs = false } = {}) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    originalName: job.originalName,
    mediaBytes: job.mediaBytes,
    model: job.model,
    language: job.language,
    durationSeconds: job.durationSeconds ?? null,
    device: job.device || null,
    segments: job.segments ?? null,
    progress: job.progress || null,
    artifacts: job.artifacts || { txt: false, srt: false },
    error: job.error || null,
    code: job.code || null,
    cancelRequested: Boolean(job.cancelRequested),
    ...(includeLogs ? { logs: Array.isArray(job.logs) ? job.logs : [] } : {}),
  };
}

function createTranscriberService({ dataDir = DEFAULT_DATA_DIR, runner } = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const jobsDir = path.join(resolvedDataDir, 'jobs');
  const incomingDir = path.join(resolvedDataDir, 'incoming');
  const jobStore = createTranscriberJobStore({ jobsDir });
  const actualRunner = runner || createTranscriberRunner();
  let jobs = new Map();
  let activeId = null;
  let activePromise = null;
  const pending = [];
  let stopped = false;
  let persistChain = Promise.resolve();

  const ready = (async () => {
    await fsp.mkdir(incomingDir, { recursive: true });
    jobs = await jobStore.hydrate();
    for (const job of jobs.values()) {
      if (job.status !== 'interrupted') continue;
      const dir = jobStore.jobDir(job.id);
      await Promise.all([
        fsp.rm(path.join(dir, 'input'), { recursive: true, force: true }),
        fsp.rm(path.join(dir, 'work'), { recursive: true, force: true }),
      ]);
    }
  })();

  function sanitizeMessage(message) {
    return String(message || '')
      .replaceAll(resolvedDataDir, '[transcriber-data]')
      .replaceAll(TOOL_DIR, '[transcriber]');
  }

  async function persist(job) {
    job.updatedAt = Date.now();
    persistChain = persistChain.catch(() => undefined).then(() => jobStore.persist(job));
    await persistChain;
  }

  async function log(job, message) {
    if (!message || !String(message).trim()) return;
    job.logs.push(nowLog(sanitizeMessage(message)));
    if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
    await persist(job);
  }

  async function cleanupWorkingFiles(job) {
    const dir = jobStore.jobDir(job.id);
    await Promise.all([
      fsp.rm(path.join(dir, 'input'), { recursive: true, force: true }),
      fsp.rm(path.join(dir, 'work'), { recursive: true, force: true }),
    ]);
  }

  async function runJob(job) {
    const dir = jobStore.jobDir(job.id);
    const inputDir = path.join(dir, 'input');
    const outputDir = path.join(dir, 'artifacts');
    const workDir = path.join(dir, 'work');
    const inputEntries = await fsp.readdir(inputDir).catch(() => []);
    const inputPath = inputEntries.length ? path.join(inputDir, inputEntries[0]) : null;
    if (!inputPath) throw new Error('Uploaded media is missing');

    job.status = 'running';
    job.error = null;
    job.code = null;
    job.progress = { phase: 'starting', percent: 1, currentChunk: 0, totalChunks: null };
    await log(job, `Starting ${job.model} transcription (${job.language === 'auto' ? 'automatic language detection' : job.language}).`);

    try {
      await fsp.mkdir(outputDir, { recursive: true });
      await fsp.mkdir(workDir, { recursive: true });
      const result = await actualRunner.runTranscription({
        inputPath,
        outputDir,
        workDir,
        model: job.model,
        language: job.language,
        onChild: (child) => { job.child = child; },
        onLog: (message) => { void log(job, message).catch(() => undefined); },
        onEvent: (event) => {
          if (event.type !== 'progress') return;
          job.progress = {
            phase: event.phase,
            percent: Number(event.percent) || 0,
            currentChunk: event.currentChunk ?? null,
            totalChunks: event.totalChunks ?? null,
          };
          void persist(job).catch(() => undefined);
        },
      });

      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.progress = { ...(job.progress || {}), phase: 'cancelled' };
        await log(job, 'Transcription cancelled.');
      } else {
        job.status = 'done';
        job.durationSeconds = Number(result.durationSeconds) || null;
        job.device = result.device || null;
        job.segments = Number(result.segments) || 0;
        job.artifacts = { txt: true, srt: true };
        job.progress = { ...(job.progress || {}), phase: 'done', percent: 100 };
        await log(job, `Transcription completed with ${job.segments} segments.`);
      }
    } catch (error) {
      if (job.cancelRequested || error?.code === 'JOB_CANCELLED' || error?.exitCode === 130) {
        job.status = 'cancelled';
        job.progress = { ...(job.progress || {}), phase: 'cancelled' };
        await log(job, 'Transcription cancelled.');
      } else {
        job.status = 'error';
        job.error = sanitizeMessage(error?.message || String(error));
        job.code = error?.code || 'TRANSCRIPTION_FAILED';
        job.progress = { ...(job.progress || {}), phase: 'error' };
        await log(job, `ERROR: ${job.error}`);
      }
    } finally {
      job.child = null;
      await cleanupWorkingFiles(job).catch(() => undefined);
      await persist(job);
    }
  }

  async function pump() {
    await ready;
    if (stopped || activeId) return;
    let next = null;
    while (pending.length && !next) {
      const candidate = jobs.get(pending.shift());
      if (candidate?.status === 'queued') next = candidate;
    }
    if (!next) return;
    activeId = next.id;
    const currentPromise = runJob(next);
    activePromise = currentPromise;
    try {
      await currentPromise;
    } finally {
      activeId = null;
      if (activePromise === currentPromise) activePromise = null;
      queueMicrotask(() => { void pump(); });
    }
  }

  async function createJob(file, options) {
    await ready;
    const id = crypto.randomUUID();
    const dir = jobStore.jobDir(id);
    const inputDir = path.join(dir, 'input');
    await fsp.mkdir(inputDir, { recursive: true });
    const extension = path.extname(file.originalname || '').toLowerCase().slice(0, 12);
    const destination = path.join(inputDir, `media${extension}`);
    await fsp.rename(file.path, destination);

    const job = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'queued',
      originalName: safeOriginalName(file.originalname),
      mediaBytes: Number(file.size) || 0,
      model: options.model,
      language: options.language,
      durationSeconds: null,
      device: null,
      segments: null,
      progress: { phase: 'queued', percent: 0, currentChunk: 0, totalChunks: null },
      artifacts: { txt: false, srt: false },
      logs: [nowLog('Upload accepted; transcription queued.')],
      error: null,
      code: null,
      cancelRequested: false,
      child: null,
    };
    jobs.set(id, job);
    pending.push(id);
    await persist(job);
    void pump();
    return job;
  }

  async function cancel(id) {
    await ready;
    const job = jobs.get(id);
    if (!job) return { error: 'not_found' };
    if (!['queued', 'running'].includes(job.status)) return { error: 'not_active', job };
    job.cancelRequested = true;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.progress = { ...(job.progress || {}), phase: 'cancelled' };
      await cleanupWorkingFiles(job);
      await log(job, 'Queued transcription cancelled.');
      return { job };
    }

    await log(job, 'Cancellation requested; stopping the worker.');
    if (job.child && job.child.exitCode === null) {
      job.child.kill('SIGTERM');
      const child = job.child;
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000);
      forceTimer.unref?.();
    }
    await persist(job);
    return { job };
  }

  async function remove(id) {
    await ready;
    const job = jobs.get(id);
    if (!job) return { error: 'not_found' };
    if (!TERMINAL_STATUSES.has(job.status)) return { error: 'active', job };
    jobs.delete(id);
    await jobStore.remove(id);
    return { job };
  }

  async function shutdown() {
    stopped = true;
    await ready;
    const active = activeId ? jobs.get(activeId) : null;
    if (active && ['queued', 'running'].includes(active.status)) await cancel(active.id);
    if (activePromise) await activePromise.catch(() => undefined);
  }

  return {
    ready,
    incomingDir,
    runner: actualRunner,
    createJob,
    cancel,
    remove,
    shutdown,
    get(id) { return jobs.get(id); },
    list() { return Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt); },
    artifactPath(id, kind) { return path.join(jobStore.jobDir(id), 'artifacts', `transcript.${kind}`); },
  };
}

function registerTranscriberRoutes(app, {
  basePath = '/api/tools/transcriber',
  dataDir = DEFAULT_DATA_DIR,
  runner,
  maxUploadBytes = configuredUploadBytes(),
} = {}) {
  const router = express.Router();
  const service = createTranscriberService({ dataDir, runner });
  const upload = multer({
    storage: multer.diskStorage({
      destination(_req, _file, callback) {
        fs.mkdir(service.incomingDir, { recursive: true }, (error) => callback(error, service.incomingDir));
      },
      filename(_req, _file, callback) { callback(null, `${crypto.randomUUID()}.upload`); },
    }),
    limits: { files: 1, fileSize: maxUploadBytes },
  });

  router.use(express.json({ limit: '1mb' }));

  router.get('/health', async (_req, res) => {
    await service.ready;
    try {
      const report = await service.runner.diagnostics();
      res.json({ ...report, tool: 'transcriber', models: MODELS, defaultModel: 'small', maxUploadBytes });
    } catch (error) {
      res.status(500).json({ ok: false, ready: false, tool: 'transcriber', error: error?.message || String(error) });
    }
  });

  router.post('/jobs', upload.single('media'), async (req, res, next) => {
    try {
      const parsed = JobOptions.safeParse({ model: req.body?.model || 'small', language: req.body?.language || 'auto' });
      if (!req.file) return res.status(400).json({ ok: false, error: 'A media file is required in the `media` field.' });
      if (!parsed.success) {
        await fsp.rm(req.file.path, { force: true });
        return res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') });
      }
      const job = await service.createJob(req.file, parsed.data);
      return res.status(202).json({ ok: true, jobId: job.id, job: publicJob(job, { includeLogs: true }) });
    } catch (error) {
      if (req.file?.path) await fsp.rm(req.file.path, { force: true }).catch(() => undefined);
      return next(error);
    }
  });

  router.get('/jobs', async (req, res) => {
    await service.ready;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json({ ok: true, jobs: service.list().slice(0, limit).map((job) => publicJob(job)) });
  });

  router.get('/jobs/:id', async (req, res) => {
    await service.ready;
    const job = service.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
    return res.json({ ok: true, job: publicJob(job, { includeLogs: true }) });
  });

  router.get('/jobs/:id/events', async (req, res) => {
    await service.ready;
    const job = service.get(req.params.id);
    if (!job) return res.status(404).end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let last = '';
    const send = () => {
      const current = service.get(req.params.id);
      if (!current) return false;
      const payload = JSON.stringify(publicJob(current, { includeLogs: true }));
      if (payload !== last) {
        res.write(`event: job\ndata: ${payload}\n\n`);
        last = payload;
      }
      if (TERMINAL_STATUSES.has(current.status)) {
        res.end();
        return false;
      }
      return true;
    };
    send();
    const interval = setInterval(() => { if (!send()) clearInterval(interval); }, 350);
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(interval);
      clearInterval(keepAlive);
    });
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const result = await service.cancel(req.params.id);
    if (result.error === 'not_found') return res.status(404).json({ ok: false, error: 'Job not found' });
    if (result.error === 'not_active') return res.status(409).json({ ok: false, error: `Job is ${result.job.status}` });
    return res.json({ ok: true, job: publicJob(result.job, { includeLogs: true }) });
  });

  router.post('/jobs/:id/delete', async (req, res) => {
    const result = await service.remove(req.params.id);
    if (result.error === 'not_found') return res.status(404).json({ ok: false, error: 'Job not found' });
    if (result.error === 'active') return res.status(409).json({ ok: false, error: 'Cancel the active job before deleting it' });
    return res.json({ ok: true });
  });

  router.get('/jobs/:id/artifacts/:kind', async (req, res) => {
    await service.ready;
    const kind = String(req.params.kind || '').toLowerCase();
    if (!['txt', 'srt'].includes(kind)) return res.status(400).json({ ok: false, error: 'Artifact kind must be txt or srt' });
    const job = service.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
    if (job.status !== 'done' || !job.artifacts?.[kind]) return res.status(409).json({ ok: false, error: 'Artifact is not ready' });
    const artifactPath = service.artifactPath(job.id, kind);
    try {
      await fsp.access(artifactPath);
      const stem = path.parse(job.originalName || 'transcript').name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'transcript';
      return res.download(artifactPath, `${stem}_${job.model}.${kind}`);
    } catch {
      return res.status(404).json({ ok: false, error: 'Artifact file is missing' });
    }
  });

  router.use((error, req, res, next) => {
    if (!(error instanceof multer.MulterError)) return next(error);
    if (req.file?.path) fsp.rm(req.file.path, { force: true }).catch(() => undefined);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: `Media exceeds the ${Math.floor(maxUploadBytes / 1024 / 1024)} MB upload limit.` });
    }
    return res.status(400).json({ ok: false, error: error.message });
  });

  app.use(basePath, router);
  return { router, service };
}

module.exports = {
  MODELS,
  TERMINAL_STATUSES,
  createTranscriberService,
  publicJob,
  registerTranscriberRoutes,
};
