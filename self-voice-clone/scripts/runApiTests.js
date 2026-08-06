const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const toolDir = path.resolve(__dirname, '..');
const apiDir = path.join(toolDir, 'vclone', 'apps', 'api');
const python = String(process.env.SELF_VOICE_CLONE_PYTHON || (process.platform === 'win32'
  ? path.join(toolDir, '.venv', 'Scripts', 'python.exe')
  : path.join(toolDir, '.venv', 'bin', 'python'))).trim();

if (!fs.existsSync(python)) {
  console.error('Self Voice Clone Python environment is missing. Run `npm run setup:self-voice-clone`.');
  process.exit(1);
}

const testDatabase = path.join(os.tmpdir(), `self-voice-clone-tests-${process.pid}.db`);
const result = spawnSync(python, ['-m', 'pytest', '-q'], {
  cwd: apiDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHONPATH: '.',
    DATABASE_URL: process.env.DATABASE_URL || `sqlite:///${testDatabase}`,
  },
});
if (!process.env.DATABASE_URL) fs.rmSync(testDatabase, { force: true });
process.exit(result.status ?? 1);
