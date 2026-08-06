const path = require('node:path');
const fsp = require('node:fs/promises');

const SERIALIZED_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'status',
  'originalName',
  'mediaBytes',
  'model',
  'language',
  'durationSeconds',
  'device',
  'segments',
  'progress',
  'artifacts',
  'logs',
  'error',
  'code',
  'cancelRequested',
];

function serializeJob(job) {
  const serialized = {};
  for (const field of SERIALIZED_FIELDS) serialized[field] = job[field] ?? null;
  serialized.logs = Array.isArray(job.logs) ? job.logs.slice(-2000) : [];
  serialized.artifacts = job.artifacts || { txt: false, srt: false };
  serialized.cancelRequested = Boolean(job.cancelRequested);
  return serialized;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function createTranscriberJobStore({ jobsDir }) {
  function jobDir(id) {
    return path.join(jobsDir, id);
  }

  async function persist(job) {
    const dir = jobDir(job.id);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'job.json');
    const temporary = `${target}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(serializeJob(job), null, 2), 'utf8');
    await fsp.rename(temporary, target);
  }

  async function hydrate() {
    await fsp.mkdir(jobsDir, { recursive: true });
    const entries = await fsp.readdir(jobsDir, { withFileTypes: true }).catch(() => []);
    const jobs = new Map();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const raw = await readJson(path.join(jobsDir, entry.name, 'job.json'));
      if (!raw?.id || raw.id !== entry.name) continue;
      const job = {
        ...raw,
        logs: Array.isArray(raw.logs) ? raw.logs : [],
        artifacts: raw.artifacts || { txt: false, srt: false },
        child: null,
        cancelRequested: false,
      };
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'interrupted';
        job.error = 'Server stopped before this transcription finished.';
        job.updatedAt = Date.now();
        job.logs.push(`[${new Date().toISOString()}] Job marked interrupted after server restart.`);
        await persist(job);
      }
      jobs.set(job.id, job);
    }
    return jobs;
  }

  async function remove(id) {
    await fsp.rm(jobDir(id), { recursive: true, force: true });
  }

  return { hydrate, persist, remove, jobDir };
}

module.exports = { createTranscriberJobStore, serializeJob };
