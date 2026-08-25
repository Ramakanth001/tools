const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBaseUrl, extractJson, chatJson, pullModel, isTransientPullError, explainPullError } = require('../src/ollama');

test('Ollama URL accepts loopback only', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.throws(() => normalizeBaseUrl('https://example.com'), /loopback/);
});

test('structured output parser handles plain and fenced JSON', () => {
  assert.deepEqual(extractJson('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => extractJson('{"items":[1 2]}'), /invalid structured output/);
});

test('malformed Qwen JSON is regenerated automatically with a larger deterministic budget', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const content = requests.length === 1 ? '{"items":[1 2]}' : '{"items":[1,2]}';
    return new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await chatJson({
      baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:14b-q4_K_M',
      schema: { type: 'object' }, messages: [{ role: 'user', content: 'Return items' }],
      options: { num_predict: 500, temperature: 0.7, top_p: 0.95 },
    });
    assert.deepEqual(response.value, { items: [1, 2] });
    assert.equal(response.metrics.structuredRetries, 1);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].options.num_predict > requests[0].options.num_predict);
    assert.equal(requests[1].options.temperature, 0.2);
    assert.match(requests[1].messages.at(-1).content, /valid JSON object/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Ollama pull failures recognize tunnel interruptions and explain that Docker is not required', () => {
  const failure = new Error('max retries exceeded: write tcp [fe80::1%utun4]: socket is not connected');
  assert.equal(isTransientPullError(failure), true);
  assert.match(explainPullError(failure), /Docker is not required/);
  assert.match(explainPullError(failure), /VPN or tunnel/);
  assert.equal(isTransientPullError(new Error('model manifest not found')), false);
});

test('Ollama pull retries a transient streamed registry error', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const progress = [];
  global.fetch = async () => {
    calls += 1;
    return new Response(calls === 1
      ? '{"error":"max retries exceeded: socket is not connected"}\n'
      : '{"status":"success"}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  try {
    const result = await pullModel({
      baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:14b-q4_K_M', retryDelays: [0, 0],
      onProgress: (event) => progress.push(event),
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 'success');
    assert.ok(progress.some((event) => event.retrying && event.retryAttempt === 2));
  } finally {
    global.fetch = originalFetch;
  }
});
