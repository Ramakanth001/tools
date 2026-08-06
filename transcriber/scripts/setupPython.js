const path = require('node:path');
const { spawnSync } = require('node:child_process');

const toolDir = path.resolve(__dirname, '..');
const venvDir = path.join(toolDir, '.venv');
const requirements = path.join(toolDir, 'requirements-runtime.txt');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: toolDir, stdio: 'inherit' });
  if (result.error || result.status !== 0) return false;
  return true;
}

function findPython() {
  const requested = String(process.env.TRANSCRIBER_BOOTSTRAP_PYTHON || '').trim();
  const candidates = requested ? [requested] : ['python3.11', 'python3.12'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.error('Python 3.11 or 3.12 is required. Install one, or set TRANSCRIBER_BOOTSTRAP_PYTHON to its executable.');
  process.exit(1);
}

if (!run(python, ['-m', 'venv', venvDir])) process.exit(1);
const venvPython = process.platform === 'win32'
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

if (!run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])) process.exit(1);
if (!run(venvPython, ['-m', 'pip', 'install', '-r', requirements])) process.exit(1);

console.log(`Transcriber Python environment is ready: ${venvPython}`);
