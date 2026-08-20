const path = require('node:path');
const { spawnSync } = require('node:child_process');

const toolDir = path.resolve(__dirname, '..');
const venvDir = path.join(toolDir, '.venv');
const requirements = path.join(toolDir, 'requirements.txt');

function run(command, args, cwd = toolDir) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return !result.error && result.status === 0;
}

function findPython() {
  const requested = String(process.env.SELF_VOICE_CLONE_BOOTSTRAP_PYTHON || '').trim();
  for (const candidate of requested ? [requested] : ['python3.11', 'python3.12']) {
    const result = spawnSync(candidate, ['-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
}

const bootstrapPython = findPython();
if (!bootstrapPython) {
  console.error('Python 3.11 or 3.12 is required. Install one, or set SELF_VOICE_CLONE_BOOTSTRAP_PYTHON.');
  process.exit(1);
}

if (!run(bootstrapPython, ['-m', 'venv', venvDir])) process.exit(1);
const venvPython = process.platform === 'win32'
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

if (!run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])) process.exit(1);
if (!run(venvPython, ['-m', 'pip', 'install', '-r', requirements])) process.exit(1);

console.log(`Self Voice Clone Python environment is ready: ${venvPython}`);
