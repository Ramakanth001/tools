const path = require('node:path');
const fsp = require('node:fs/promises');

function jsonPath(root, type, id) {
  return path.join(root, type, `${id}.json`);
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
      return readJson(jsonPath(rootDir, 'projects', id));
    },
    async listProjects() {
      return listJson(path.join(rootDir, 'projects'));
    },
    async saveRun(run) {
      return writeJson(jsonPath(rootDir, 'runs', run.id), run);
    },
    async getRun(id) {
      return readJson(jsonPath(rootDir, 'runs', id));
    },
    async listRuns() {
      return listJson(path.join(rootDir, 'runs'));
    },
    async saveReport(report) {
      return writeJson(jsonPath(rootDir, 'reports', report.id), report);
    },
    async saveReplay(replay) {
      return writeJson(jsonPath(rootDir, 'replays', replay.id), replay);
    },
    async listReplays(runId) {
      return (await listJson(path.join(rootDir, 'replays'))).filter((item) => item.runId === runId);
    },
    async saveError(errorRecord) {
      return writeJson(jsonPath(rootDir, 'errors', errorRecord.id), errorRecord);
    },
    async listErrors(runId) {
      return (await listJson(path.join(rootDir, 'errors'))).filter((item) => item.runId === runId);
    },
    async saveCheckpoint(checkpoint) {
      return writeJson(jsonPath(rootDir, 'checkpoints', checkpoint.id), checkpoint);
    },
    async listCheckpoints(runId) {
      return (await listJson(path.join(rootDir, 'checkpoints'))).filter((item) => item.runId === runId);
    },
  };
}

module.exports = { createPersistence };