const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const toolDir = path.resolve(__dirname, '..');
const apiDir = path.join(toolDir, 'vclone', 'apps', 'api');
const defaultPython = process.platform === 'win32'
  ? path.join(toolDir, '.venv', 'Scripts', 'python.exe')
  : path.join(toolDir, '.venv', 'bin', 'python');
const python = String(process.env.SELF_VOICE_CLONE_PYTHON || defaultPython).trim();
const port = String(process.env.SELF_VOICE_CLONE_API_PORT || '8792');
const reload = process.argv.includes('--reload');

if (!fs.existsSync(python)) {
  console.error(`Self Voice Clone Python environment is missing: ${python}`);
  console.error('Run `npm run setup:self-voice-clone` from the tools workspace.');
  process.exit(1);
}

const args = ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', port];
if (reload) args.push('--reload');

const child = spawn(python, args, {
  cwd: apiDir,
  stdio: 'inherit',
  env: { ...process.env, PYTHONUNBUFFERED: '1' },
});

function forward(signal) {
  if (!child.killed) child.kill(signal);
}

process.once('SIGINT', () => forward('SIGINT'));
process.once('SIGTERM', () => forward('SIGTERM'));
child.once('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
