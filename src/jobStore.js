const path = require('node:path');
const fsp = require('node:fs/promises');

const JOBS_DIR_NAME = '.jobs';
const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

async function safeStat(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function serializeJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt || Date.now(),
    status: job.status || 'unknown',
    logs: Array.isArray(job.logs) ? job.logs.slice(-1000) : [],
    zipPath: job.zipPath || null,
    folderPath: job.folderPath || null,
    error: job.error || null,
    code: job.code || null,
    stack: job.stack || null,
    progress: job.progress || null,
    zipBytes: job.zipBytes ?? null,
    cancelRequested: Boolean(job.cancelRequested),
  };
}

function restoreJob(raw) {
  const job = {
    ...serializeJob(raw || {}),
    childPids: new Set(),
    cancelRequested: false,
  };
  if (job.status === 'running' || job.status === 'queued') {
    job.status = 'interrupted';
    job.error = job.error || 'Server stopped before this job finished.';
  }
  return job;
}

function idFromStamp(stamp) {
  return `artifact_${String(stamp || '').replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function createJobStore({ backupsDir }) {
  const jobsDir = path.join(backupsDir, JOBS_DIR_NAME);

  async function persist(job) {
    if (!job?.id) return;
    await fsp.mkdir(jobsDir, { recursive: true });
    await fsp.writeFile(path.join(jobsDir, `${job.id}.json`), JSON.stringify(serializeJob(job), null, 2), 'utf8');
  }

  async function remove(jobOrId) {
    const id = typeof jobOrId === 'string' ? jobOrId : jobOrId?.id;
    if (!id) return;
    await fsp.rm(path.join(jobsDir, `${id}.json`), { force: true });
  }

  async function hydrate(jobs) {
    await fsp.mkdir(backupsDir, { recursive: true });
    await fsp.mkdir(jobsDir, { recursive: true });

    const metadataFiles = await fsp.readdir(jobsDir).catch(() => []);
    for (const file of metadataFiles) {
      if (!file.endsWith('.json')) continue;
      const raw = await readJson(path.join(jobsDir, file));
      if (!raw?.id) continue;
      jobs.set(raw.id, restoreJob(raw));
    }

    const entries = await fsp.readdir(backupsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === JOBS_DIR_NAME || entry.name === 'schema-snapshots') continue;
      const isZip = entry.isFile() && entry.name.endsWith('.zip');
      const stamp = isZip ? entry.name.slice(0, -4) : entry.name;
      if (!STAMP_RE.test(stamp)) continue;

      const id = idFromStamp(stamp);
      if (jobs.has(id)) continue;
      const folderPath = path.join(backupsDir, stamp);
      const zipPath = path.join(backupsDir, `${stamp}.zip`);
      const folderStat = await safeStat(folderPath);
      const zipStat = await safeStat(zipPath);
      const createdAt = (zipStat || folderStat)?.mtimeMs || Date.now();
      jobs.set(id, {
        id,
        createdAt,
        status: zipStat ? 'done' : 'artifact',
        logs: [`[${new Date(createdAt).toISOString()}] Rehydrated backup artifact from disk.`],
        zipPath: zipStat ? zipPath : null,
        folderPath: folderStat ? folderPath : null,
        error: null,
        code: null,
        stack: null,
        progress: null,
        zipBytes: zipStat?.size ?? null,
        childPids: new Set(),
        cancelRequested: false,
      });
    }

    await Promise.all(Array.from(jobs.values()).map((job) => persist(job).catch(() => undefined)));
  }

  return { hydrate, persist, remove };
}

module.exports = { createJobStore, serializeJob };
