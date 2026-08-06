const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { EventEmitter, once } = require('node:events');
const { requireToolDep } = require('../requireToolDep');
const { registerTranscriberRoutes } = require('../src/registerRoutes');

const express = requireToolDep('express');

function createFakeRunner({ delayMs = 5, blocking = false, tracker } = {}) {
  return {
    async diagnostics() {
      return {
        ok: true,
        ready: true,
        device: 'cpu',
        checks: {
          python: { ok: true, version: '3.11.9' },
          ffmpeg: { ok: true, path: '/usr/bin/ffmpeg' },
          ffprobe: { ok: true, path: '/usr/bin/ffprobe' },
          torch: { ok: true, version: 'test' },
          whisper: { ok: true, version: 'test' },
        },
      };
    },
    runTranscription({ outputDir, onEvent, onLog, onChild }) {
      tracker && (tracker.active += 1);
      if (tracker) tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      let settled = false;
      let rejectRun;
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        if (settled) return false;
        settled = true;
        child.exitCode = signal === 'SIGKILL' ? 137 : 130;
        const error = new Error('cancelled');
        error.code = 'JOB_CANCELLED';
        error.exitCode = 130;
        rejectRun(error);
        return true;
      };
      onChild(child);
      onLog('fake worker started');
      onEvent({ type: 'progress', phase: 'transcribing', percent: 50, currentChunk: 1, totalChunks: 2 });

      return new Promise((resolve, reject) => {
        rejectRun = reject;
        if (blocking) return;
        setTimeout(async () => {
          if (settled) return;
          settled = true;
          child.exitCode = 0;
          await fsp.mkdir(outputDir, { recursive: true });
          await fsp.writeFile(path.join(outputDir, 'transcript.txt'), 'hello from fake whisper', 'utf8');
          await fsp.writeFile(path.join(outputDir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n', 'utf8');
          if (tracker) tracker.active -= 1;
          resolve({ durationSeconds: 61, device: 'cpu', segments: 1, artifacts: { txt: 'transcript.txt', srt: 'transcript.srt' } });
        }, delayMs);
      }).finally(() => {
        if (tracker && tracker.active > 0 && blocking) tracker.active -= 1;
      });
    },
  };
}

async function createHarness(options = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'transcriber-routes-'));
  const app = express();
  const { service } = registerTranscriberRoutes(app, {
    basePath: '/api',
    dataDir,
    runner: options.runner || createFakeRunner(),
    maxUploadBytes: options.maxUploadBytes || 1024 * 1024,
  });
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  return {
    baseUrl,
    dataDir,
    service,
    async close() {
      await service.shutdown();
      await new Promise((resolve) => server.close(resolve));
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function upload(baseUrl, { content = 'media', model = 'small', language = 'auto' } = {}) {
  const body = new FormData();
  body.append('media', new Blob([content], { type: 'audio/wav' }), 'sample.wav');
  body.append('model', model);
  body.append('language', language);
  return fetch(`${baseUrl}/jobs`, { method: 'POST', body });
}

async function waitForJob(baseUrl, id, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/jobs/${id}`);
    const payload = await response.json();
    if (predicate(payload.job)) return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

test('health reports the supported runtime and jobs require media', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const health = await fetch(`${harness.baseUrl}/health`).then((response) => response.json());
  assert.equal(health.ready, true);
  assert.equal(health.defaultModel, 'small');
  assert.equal(health.maxUploadBytes, 1024 * 1024);
  assert.deepEqual(health.models, ['tiny', 'base', 'small', 'medium', 'turbo']);

  const missing = await fetch(`${harness.baseUrl}/jobs`, { method: 'POST', body: new FormData() });
  assert.equal(missing.status, 400);
});

test('uploaded jobs complete and expose isolated TXT/SRT artifacts', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const response = await upload(harness.baseUrl, { model: 'base', language: 'en' });
  assert.equal(response.status, 202);
  const created = await response.json();
  const job = await waitForJob(harness.baseUrl, created.jobId, (candidate) => candidate.status === 'done');
  assert.equal(job.model, 'base');
  assert.equal(job.language, 'en');
  assert.equal(job.artifacts.txt, true);
  assert.equal(Object.hasOwn(job, 'inputPath'), false);

  const txt = await fetch(`${harness.baseUrl}/jobs/${job.id}/artifacts/txt`);
  assert.equal(txt.status, 200);
  assert.equal(await txt.text(), 'hello from fake whisper');
  const unsupported = await fetch(`${harness.baseUrl}/jobs/${job.id}/artifacts/json`);
  assert.equal(unsupported.status, 400);

  const removed = await fetch(`${harness.baseUrl}/jobs/${job.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(`${harness.baseUrl}/jobs/${job.id}`)).status, 404);
});

test('upload limits and option validation fail cleanly', async (t) => {
  const harness = await createHarness({ maxUploadBytes: 4 });
  t.after(() => harness.close());
  const tooLarge = await upload(harness.baseUrl, { content: '12345' });
  assert.equal(tooLarge.status, 413);
  const invalid = await upload(harness.baseUrl, { content: '123', language: 'English' });
  assert.equal(invalid.status, 400);
});

test('running jobs can be cancelled', async (t) => {
  const harness = await createHarness({ runner: createFakeRunner({ blocking: true }) });
  t.after(() => harness.close());
  const created = await upload(harness.baseUrl).then((response) => response.json());
  await waitForJob(harness.baseUrl, created.jobId, (job) => job.status === 'running');
  const cancelled = await fetch(`${harness.baseUrl}/jobs/${created.jobId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(cancelled.status, 200);
  const job = await waitForJob(harness.baseUrl, created.jobId, (candidate) => candidate.status === 'cancelled');
  assert.equal(job.cancelRequested, true);
});

test('the queue runs only one transcription at a time', async (t) => {
  const tracker = { active: 0, maxActive: 0 };
  const harness = await createHarness({ runner: createFakeRunner({ delayMs: 40, tracker }) });
  t.after(() => harness.close());
  const first = await upload(harness.baseUrl).then((response) => response.json());
  const second = await upload(harness.baseUrl).then((response) => response.json());
  await Promise.all([
    waitForJob(harness.baseUrl, first.jobId, (job) => job.status === 'done'),
    waitForJob(harness.baseUrl, second.jobId, (job) => job.status === 'done'),
  ]);
  assert.equal(tracker.maxActive, 1);
});

test('SSE streams sanitized job updates through terminal completion', async (t) => {
  const harness = await createHarness({ runner: createFakeRunner({ delayMs: 40 }) });
  t.after(() => harness.close());
  const created = await upload(harness.baseUrl).then((response) => response.json());
  const response = await fetch(`${harness.baseUrl}/jobs/${created.jobId}/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text();
  assert.match(stream, /event: job/);
  assert.match(stream, /"status":"done"/);
  assert.doesNotMatch(stream, /inputPath|outputDir|workDir/);
});

test('hydration marks unfinished jobs interrupted without exposing paths', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'transcriber-hydrate-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const dir = path.join(dataDir, 'jobs', id);
  await fsp.mkdir(path.join(dir, 'input'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify({
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    originalName: 'meeting.wav',
    model: 'small',
    language: 'auto',
    logs: [],
    artifacts: { txt: false, srt: false },
  }));

  const app = express();
  const { service } = registerTranscriberRoutes(app, { basePath: '/api', dataDir, runner: createFakeRunner() });
  await service.ready;
  t.after(async () => {
    await service.shutdown();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(service.get(id).status, 'interrupted');
  await assert.rejects(() => fsp.access(path.join(dir, 'input')));
});
