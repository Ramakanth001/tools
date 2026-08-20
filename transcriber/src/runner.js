const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const TOOL_DIR = path.resolve(__dirname, '..');
const WORKER_PATH = path.join(TOOL_DIR, 'python', 'transcriber_worker.py');

function defaultPythonPath() {
  if (process.env.TRANSCRIBER_PYTHON) return path.resolve(process.env.TRANSCRIBER_PYTHON);
  return process.platform === 'win32'
    ? path.join(TOOL_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(TOOL_DIR, '.venv', 'bin', 'python');
}

function createLineReader(callback) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) if (line.trim()) callback(line);
    },
    flush() {
      if (pending.trim()) callback(pending);
      pending = '';
    },
  };
}

// tqdm (used by Whisper while downloading a model) redraws one status line with
// carriage returns instead of newlines. Treat those redraws as log entries, but
// coalesce them so a fast download does not create thousands of job writes/SSE
// messages per second.
function createProgressReader(callback, { intervalMs = 500 } = {}) {
  let pending = '';
  let latest = '';
  let timer = null;
  let lastEmittedAt = 0;

  function emitLatest() {
    if (!latest) return;
    const line = latest;
    latest = '';
    lastEmittedAt = Date.now();
    callback(line);
  }

  function scheduleLatest() {
    if (timer || !latest) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastEmittedAt));
    timer = setTimeout(() => {
      timer = null;
      emitLatest();
    }, delay);
    timer.unref?.();
  }

  function reportCarriageReturn(line) {
    latest = line;
    if (!lastEmittedAt || Date.now() - lastEmittedAt >= intervalMs) emitLatest();
    else scheduleLatest();
  }

  function reportNewline(line) {
    if (timer) clearTimeout(timer);
    timer = null;
    emitLatest();
    callback(line);
  }

  return {
    push(chunk) {
      pending += chunk.toString();
      let separator;
      while ((separator = pending.search(/[\r\n]/)) !== -1) {
        const line = pending.slice(0, separator).trim();
        const isCarriageReturn = pending[separator] === '\r';
        pending = pending.slice(separator + 1);
        if (pending[0] === '\n' && isCarriageReturn) pending = pending.slice(1);
        if (!line) continue;
        if (isCarriageReturn) reportCarriageReturn(line);
        else reportNewline(line);
      }
    },
    flush() {
      if (pending.trim()) reportNewline(pending.trim());
      pending = '';
      if (timer) clearTimeout(timer);
      timer = null;
      emitLatest();
    },
  };
}

async function pythonExists(pythonPath) {
  try {
    await fsp.access(pythonPath);
    return true;
  } catch {
    return false;
  }
}

function runProcess(args, { onEvent = () => {}, onLog = () => {}, onChild = () => {}, cacheDir } = {}) {
  const pythonPath = defaultPythonPath();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [WORKER_PATH, ...args], {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // Qwen3-ASR uses Hugging Face's cache; keep it beside Whisper's ignored cache.
        ...(cacheDir ? { HF_HOME: path.join(cacheDir, 'huggingface') } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onChild(child);

    let result = null;
    let reportedError = null;
    const stdout = createLineReader((line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') result = event;
        if (event.type === 'error') reportedError = event.message || 'Transcription failed';
        if (event.type === 'log') onLog(event.message || '');
        onEvent(event);
      } catch {
        onLog(line);
      }
    });
    const stderr = createProgressReader(onLog);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      stdout.flush();
      stderr.flush();
      if (code === 0 && result) return resolve(result);
      const error = new Error(reportedError || `Transcriber worker exited with ${signal || `code ${code}`}`);
      error.code = code === 130 ? 'JOB_CANCELLED' : 'TRANSCRIBER_WORKER_FAILED';
      error.exitCode = code;
      error.signal = signal;
      reject(error);
    });
  });
}

function createTranscriberRunner({ cacheDir } = {}) {
  const resolvedCacheDir = path.resolve(cacheDir || process.env.TRANSCRIBER_MODEL_CACHE || path.join(TOOL_DIR, '.cache', 'whisper'));

  async function diagnostics() {
    const pythonPath = defaultPythonPath();
    if (!(await pythonExists(pythonPath))) {
      return {
        ok: true,
        ready: false,
        device: 'unknown',
        cacheDir: resolvedCacheDir,
        checks: {
          python: {
            ok: false,
            executable: pythonPath,
            error: 'Python environment not found. Run `npm run setup:transcriber` from the workspace root.',
          },
        },
      };
    }

    return new Promise((resolve) => {
      const child = spawn(pythonPath, [WORKER_PATH, '--diagnostics', '--cache-dir', resolvedCacheDir], {
        cwd: TOOL_DIR,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let errorOutput = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
      child.on('error', (error) => resolve({ ok: true, ready: false, checks: { python: { ok: false, error: error.message } } }));
      child.on('close', (code) => {
        try {
          const payload = JSON.parse(output.trim());
          resolve(payload);
        } catch {
          resolve({
            ok: true,
            ready: false,
            checks: { python: { ok: false, executable: pythonPath, error: errorOutput.trim() || `Diagnostics exited with code ${code}` } },
          });
        }
      });
    });
  }

  function runTranscription({ inputPath, outputDir, workDir, engine, model, language, chunkSeconds = 600, onEvent, onLog, onChild }) {
    return runProcess(
      [
        '--input', inputPath,
        '--output-dir', outputDir,
        '--work-dir', workDir,
        '--cache-dir', resolvedCacheDir,
        '--engine', engine,
        '--model', model,
        '--language', language,
        '--chunk-seconds', String(chunkSeconds),
      ],
      { onEvent, onLog, onChild, cacheDir: resolvedCacheDir }
    );
  }

  function extractAudio({ inputPath, outputDir, onEvent, onLog, onChild }) {
    return runProcess(
      [
        '--input', inputPath,
        '--output-dir', outputDir,
        '--cache-dir', resolvedCacheDir,
        '--extract-audio',
      ],
      { onEvent, onLog, onChild, cacheDir: resolvedCacheDir }
    );
  }

  return { diagnostics, extractAudio, runTranscription, pythonPath: defaultPythonPath(), cacheDir: resolvedCacheDir };
}

module.exports = { createLineReader, createProgressReader, createTranscriberRunner, defaultPythonPath };
