const path = require('node:path');
const fsp = require('node:fs/promises');

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

function isSafeId(id) {
  return SAFE_ID_RE.test(String(id || ''));
}

function assertSafeId(id, label = 'id') {
  if (isSafeId(id)) return String(id);
  const err = new Error(`Invalid ${label}`);
  err.code = 'INVALID_ID';
  throw err;
}

function jsonPath(root, type, id) {
  const safeId = assertSafeId(id, type);
  const baseDir = path.resolve(root, type);
  const filePath = path.resolve(baseDir, `${safeId}.json`);
  const relative = path.relative(baseDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const err = new Error(`Invalid ${type} path`);
    err.code = 'INVALID_PATH';
    throw err;
  }
  return filePath;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  return value;
}

async function listJson(dir) {
  await ensureDir(dir);
  const entries = await fsp.readdir(dir);
  const values = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const value = await readJson(path.join(dir, entry));
    if (value) values.push(value);
  }
  values.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  return values;
}

function createPersistence({ rootDir }) {
  return {
    async saveProject(project) {
      return writeJson(jsonPath(rootDir, 'projects', project.id), project);
    },
    async getProject(id) {
      if (!isSafeId(id)) return null;
      return readJson(jsonPath(rootDir, 'projects', id));
    },
    async listProjects() {
      return listJson(path.join(rootDir, 'projects'));
    },
    async saveRun(run) {
      return writeJson(jsonPath(rootDir, 'runs', run.id), run);
    },
    async getRun(id) {
      if (!isSafeId(id)) return null;
      return readJson(jsonPath(rootDir, 'runs', id));
    },
    async listRuns() {
      return listJson(path.join(rootDir, 'runs'));
    },
    async saveReport(report) {
      return writeJson(jsonPath(rootDir, 'reports', report.id), report);
    },
    async listReports(projectId, type) {
      return (await listJson(path.join(rootDir, 'reports'))).filter((item) => {
        if (projectId && item.projectId !== projectId) return false;
        if (type && item.type !== type) return false;
        return true;
      });
    },
    async saveReplay(replay) {
      return writeJson(jsonPath(rootDir, 'replays', replay.id), replay);
    },
    async listReplays(runId) {
      if (runId && !isSafeId(runId)) return [];
      return (await listJson(path.join(rootDir, 'replays'))).filter((item) => item.runId === runId);
    },
    async saveError(errorRecord) {
      return writeJson(jsonPath(rootDir, 'errors', errorRecord.id), errorRecord);
    },
    async listErrors(runId) {
      if (runId && !isSafeId(runId)) return [];
      return (await listJson(path.join(rootDir, 'errors'))).filter((item) => item.runId === runId);
    },
    async saveCheckpoint(checkpoint) {
      return writeJson(jsonPath(rootDir, 'checkpoints', checkpoint.id), checkpoint);
    },
    async listCheckpoints(runId) {
      if (runId && !isSafeId(runId)) return [];
      return (await listJson(path.join(rootDir, 'checkpoints'))).filter((item) => item.runId === runId);
    },
    async saveWatermarks(projectId, watermarks) {
      return writeJson(jsonPath(rootDir, 'watermarks', projectId), {
        projectId,
        ...(watermarks || {}),
        updatedAt: new Date().toISOString(),
      });
    },
    async getWatermarks(projectId) {
      if (!isSafeId(projectId)) return null;
      return readJson(jsonPath(rootDir, 'watermarks', projectId));
    },
    async updateTableWatermark(projectId, tableName, patch) {
      const existing = (await readJson(jsonPath(rootDir, 'watermarks', projectId))) || { projectId, tables: {}, createdAt: new Date().toISOString() };
      const tables = { ...(existing.tables || {}) };
      tables[tableName] = {
        ...(tables[tableName] || {}),
        ...(patch || {}),
        updatedAt: new Date().toISOString(),
      };
      return writeJson(jsonPath(rootDir, 'watermarks', projectId), { ...existing, projectId, tables, updatedAt: new Date().toISOString() });
    },
    async resetTableWatermark(projectId, tableName) {
      const existing = (await readJson(jsonPath(rootDir, 'watermarks', projectId))) || { projectId, tables: {}, createdAt: new Date().toISOString() };
      const tables = { ...(existing.tables || {}) };
      delete tables[tableName];
      return writeJson(jsonPath(rootDir, 'watermarks', projectId), { ...existing, projectId, tables, updatedAt: new Date().toISOString() });
    },
  };
}

module.exports = { createPersistence };
