const path = require('node:path');
const fsp = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const REQUIREMENTS_FILENAME = 'setup.requirements.json';
const DEFAULT_TIMEOUT_MS = 5_000;

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function relativeDisplayPath(workspaceDir, target) {
  return path.relative(workspaceDir, target).split(path.sep).join('/');
}

function assertInside(parent, target, label) {
  const relative = path.relative(parent, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its tool directory`);
  }
}

async function defaultRunCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

async function checkNodePackages(check, context) {
  const packageFile = path.resolve(context.toolDir, check.packageFile || 'package.json');
  assertInside(context.toolDir, packageFile, 'packageFile');

  let packageJson;
  try {
    packageJson = JSON.parse(await fsp.readFile(packageFile, 'utf8'));
  } catch (error) {
    return { ok: false, detail: `Cannot read ${path.basename(packageFile)}: ${error.message}` };
  }

  const names = [
    ...Object.keys(packageJson.dependencies || {}),
    ...(check.includeDev === false ? [] : Object.keys(packageJson.devDependencies || {})),
  ];
  if (!names.length) return { ok: true, detail: 'No npm packages required' };

  const loader = createRequire(packageFile);
  const missing = names.filter((name) => {
    try {
      loader.resolve(name);
      return false;
    } catch {
      return true;
    }
  });

  if (missing.length) {
    return {
      ok: false,
      detail: `${missing.length} missing: ${missing.join(', ')}`,
    };
  }
  return { ok: true, detail: `${names.length} npm package${names.length === 1 ? '' : 's'} available` };
}

async function checkCommand(check, context) {
  const configured = check.envVar ? String(process.env[check.envVar] || '').trim() : '';
  const command = configured || check.command;
  if (!command) return { ok: false, detail: 'No executable was configured' };

  try {
    const result = await context.runCommand(command, check.args || ['--version'], {
      cwd: context.toolDir,
      timeoutMs: check.timeoutMs,
    });
    const version = firstLine(result.stdout) || firstLine(result.stderr) || 'Available';
    const source = configured ? ` via ${check.envVar}` : '';
    return { ok: true, detail: `${version}${source}` };
  } catch (error) {
    const source = configured ? `${check.envVar} (${configured})` : command;
    const reason = error.code === 'ENOENT' ? 'not found' : firstLine(error.stderr) || firstLine(error.message) || 'unavailable';
    return { ok: false, detail: `${source}: ${reason}` };
  }
}

async function checkPythonEnvironment(check, context) {
  const configured = check.envVar ? String(process.env[check.envVar] || '').trim() : '';
  const relativePython = process.platform === 'win32'
    ? (check.windowsPath || '.venv/Scripts/python.exe')
    : (check.path || '.venv/bin/python');
  const python = configured || path.resolve(context.toolDir, relativePython);

  if (!configured) assertInside(context.toolDir, python, 'python path');
  try {
    await fsp.access(python, fsConstants.X_OK);
  } catch {
    const shown = configured ? `${check.envVar} (${configured})` : relativePython;
    return { ok: false, detail: `Python environment not found at ${shown}` };
  }

  const modules = Array.isArray(check.modules) ? check.modules : [];
  const probe = [
    'import importlib.util, json, sys',
    'names = sys.argv[1:]',
    'missing = [name for name in names if importlib.util.find_spec(name) is None]',
    'print(json.dumps({"version": sys.version.split()[0], "missing": missing}))',
  ].join('; ');

  try {
    const result = await context.runCommand(python, ['-c', probe, ...modules], {
      cwd: context.toolDir,
      timeoutMs: check.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    const payload = JSON.parse(firstLine(result.stdout));
    if (payload.missing?.length) {
      return { ok: false, detail: `Python ${payload.version}; missing: ${payload.missing.join(', ')}` };
    }
    const moduleSummary = modules.length ? `; ${modules.length} required modules available` : '';
    return { ok: true, detail: `Python ${payload.version}${moduleSummary}` };
  } catch (error) {
    return { ok: false, detail: firstLine(error.stderr) || firstLine(error.message) || 'Python check failed' };
  }
}

async function evaluateCheck(check, context) {
  let result;
  if (check.type === 'node-packages') result = await checkNodePackages(check, context);
  else if (check.type === 'command') result = await checkCommand(check, context);
  else if (check.type === 'python-environment') result = await checkPythonEnvironment(check, context);
  else result = { ok: false, detail: `Unknown setup check type: ${check.type}` };

  return {
    id: check.id,
    label: check.label || check.id,
    type: check.type,
    required: check.required !== false,
    fix: check.fix || '',
    ...result,
  };
}

async function evaluateRequirements(requirements, {
  workspaceDir,
  toolDir,
  runCommand = defaultRunCommand,
} = {}) {
  if (!requirements || typeof requirements !== 'object') throw new Error('Requirements must be an object');
  if (!requirements.toolId) throw new Error('Requirements file is missing toolId');
  if (!Array.isArray(requirements.checks)) throw new Error('Requirements file is missing checks');

  const context = { workspaceDir, toolDir, runCommand };
  const checks = await Promise.all(requirements.checks.map((check) => evaluateCheck(check, context)));
  return {
    ready: checks.every((check) => !check.required || check.ok),
    checks,
  };
}

function createSetupChecker({ workspaceDir, toolIds, runCommand = defaultRunCommand }) {
  const allowedToolIds = new Set(toolIds);

  return async function checkToolSetup(toolId) {
    if (!allowedToolIds.has(toolId)) {
      const error = new Error(`Unknown tool: ${toolId}`);
      error.code = 'UNKNOWN_TOOL';
      throw error;
    }

    const toolDir = path.join(workspaceDir, toolId);
    const requirementsPath = path.join(toolDir, REQUIREMENTS_FILENAME);
    const requirements = JSON.parse(await fsp.readFile(requirementsPath, 'utf8'));
    if (requirements.toolId !== toolId) {
      throw new Error(`${REQUIREMENTS_FILENAME} declares ${requirements.toolId || 'no tool'}, expected ${toolId}`);
    }

    const result = await evaluateRequirements(requirements, { workspaceDir, toolDir, runCommand });
    return {
      ok: true,
      toolId,
      ...result,
      setupCommand: requirements.setupCommand || '',
      requirementsFile: relativeDisplayPath(workspaceDir, requirementsPath),
      checkedAt: new Date().toISOString(),
    };
  };
}

module.exports = {
  REQUIREMENTS_FILENAME,
  createSetupChecker,
  evaluateRequirements,
};
