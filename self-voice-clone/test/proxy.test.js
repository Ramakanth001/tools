const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const { applyLocalApiAuth } = require('../../src/localAuth');
const { registerSelfVoiceCloneProxy } = require('../src/registerRoutes');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('proxy preserves versioned paths, streams request bodies, binary responses, and auth', async () => {
  let observed = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      observed = { url: req.url, method: req.method, bytes: body.length };
      if (req.url.startsWith('/v1/synthesis/example/file')) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.from([0x52, 0x49, 0x46, 0x46]));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(observed));
    });
  });
  const upstreamPort = await listen(upstream);

  const previousToken = process.env.TOOLS_AUTH_TOKEN;
  process.env.TOOLS_AUTH_TOKEN = 'proxy-test-token';
  const app = express();
  applyLocalApiAuth(app, { apiPrefixes: ['/api'], host: '127.0.0.1', toolName: 'test' });
  registerSelfVoiceCloneProxy(app, {
    target: `http://127.0.0.1:${upstreamPort}`,
    basePath: '/api/tools/self-voice-clone',
  });
  const proxy = http.createServer(app);
  const proxyPort = await listen(proxy);

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${proxyPort}/api/tools/self-voice-clone/v1/system/capabilities`);
    assert.equal(unauthorized.status, 401);

    const largeBody = Buffer.alloc(2 * 1024 * 1024, 7);
    const upload = await fetch(`http://127.0.0.1:${proxyPort}/api/tools/self-voice-clone/v1/uploads/sessions/id/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-tools-auth': 'proxy-test-token' },
      body: largeBody,
    });
    assert.equal(upload.status, 200);
    assert.deepEqual(await upload.json(), {
      url: '/v1/uploads/sessions/id/chunks/0',
      method: 'PUT',
      bytes: largeBody.length,
    });

    const binary = await fetch(`http://127.0.0.1:${proxyPort}/api/tools/self-voice-clone/v1/synthesis/example/file?token=proxy-test-token`);
    assert.equal(binary.status, 200);
    assert.equal(binary.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    assert.equal(observed.url, '/v1/synthesis/example/file?token=proxy-test-token');
  } finally {
    if (previousToken === undefined) delete process.env.TOOLS_AUTH_TOKEN;
    else process.env.TOOLS_AUTH_TOKEN = previousToken;
    await close(proxy);
    await close(upstream);
  }
});

test('proxy returns an actionable JSON error when FastAPI is unavailable', async () => {
  const app = express();
  registerSelfVoiceCloneProxy(app, { target: 'http://127.0.0.1:1' });
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tools/self-voice-clone/health`);
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.match(payload.setup, /setup:self-voice-clone/);
  } finally {
    await close(server);
  }
});
