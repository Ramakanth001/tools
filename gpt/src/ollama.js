const os = require('node:os');

function normalizeBaseUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:11434'));
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error('Ollama URL must use a loopback host');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama URL must use HTTP or HTTPS');
  return url.toString().replace(/\/+$/, '');
}

function normalizedModel(value) {
  const model = String(value || '').trim().toLocaleLowerCase();
  return model.includes(':') ? model : `${model}:latest`;
}

function abortableTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  let fromParent = false;
  const onAbort = () => { fromParent = true; controller.abort(signal?.reason); };
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  return {
    signal: controller.signal,
    wasParentAbort: () => fromParent,
    close: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

class GenerationQueue {
  constructor() { this.tail = Promise.resolve(); this.depth = 0; }
  async run(callback, signal) {
    let release;
    const previous = this.tail;
    this.tail = new Promise((resolve) => { release = resolve; });
    this.depth += 1;
    try {
      await Promise.race([
        previous,
        new Promise((_, reject) => {
          if (signal?.aborted) reject(Object.assign(new Error('Generation cancelled'), { name: 'AbortError' }));
          else signal?.addEventListener('abort', () => reject(Object.assign(new Error('Generation cancelled'), { name: 'AbortError' })), { once: true });
        }),
      ]);
      return await callback();
    } finally { this.depth -= 1; release(); }
  }
}

const generationQueue = new GenerationQueue();

async function request(baseUrl, path, { method = 'POST', body, signal, timeoutMs = 180000 } = {}) {
  const timeout = abortableTimeout(signal, timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeout.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Ollama returned HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError' && timeout.wasParentAbort()) throw Object.assign(new Error('Generation cancelled'), { name: 'AbortError' });
    if (error?.name === 'AbortError') throw new Error('Ollama request timed out');
    if (error instanceof TypeError || /fetch failed|ECONNREFUSED|ENOTFOUND/iu.test(String(error?.message || ''))) {
      throw new Error(`Cannot reach Ollama at ${normalizeBaseUrl(baseUrl)}.`);
    }
    throw error;
  } finally { timeout.close(); }
}

async function listModels({ baseUrl, signal }) {
  const payload = await request(baseUrl, '/api/tags', { method: 'GET', signal, timeoutMs: 15000 });
  return Array.isArray(payload.models) ? payload.models : [];
}

function isTransientPullError(error) {
  return /max retries exceeded|socket is not connected|unexpected EOF|TLS handshake timeout|connection reset|network is unreachable|no such host|i\/o timeout|timed out|broken pipe/iu
    .test(String(error?.message || error || ''));
}

function explainPullError(error) {
  const message = String(error?.message || error || 'Model installation failed');
  if (/utun\d+|max retries exceeded|socket is not connected/iu.test(message)) {
    return 'Ollama lost its model-download connection through a VPN or tunnel route. Docker is not required. Disconnect or stabilize the VPN/tunnel (or switch networks), then press Retry; already downloaded model data can be reused.';
  }
  if (isTransientPullError(error)) {
    return 'Ollama’s model download was interrupted by the network. Docker is not required. Check the connection and press Retry; already downloaded model data can be reused.';
  }
  return message;
}

function retryDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Model installation cancelled'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Model installation cancelled'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function pullModelOnce({ baseUrl, model, signal, onProgress = () => {} }) {
  const timeout = abortableTimeout(signal, 6 * 60 * 60 * 1000);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/pull`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }), signal: timeout.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Ollama returned HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('Ollama did not return model download progress');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let latest = { status: 'starting' };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        latest = event;
        onProgress(event);
      }
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer);
      if (event.error) throw new Error(event.error);
      latest = event;
      onProgress(event);
    }
    return latest;
  } catch (error) {
    if (timeout.wasParentAbort()) throw Object.assign(new Error('Model installation cancelled'), { name: 'AbortError' });
    if (error?.name === 'AbortError') throw new Error('Ollama model installation timed out');
    if (error instanceof TypeError || /fetch failed|ECONNREFUSED|ENOTFOUND/iu.test(String(error?.message || ''))) {
      throw new Error(`Cannot reach Ollama at ${normalizeBaseUrl(baseUrl)}.`);
    }
    throw error;
  } finally { timeout.close(); }
}

async function pullModel({ baseUrl, model, signal, onProgress = () => {}, retryDelays = [2000, 5000] }) {
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await pullModelOnce({ baseUrl, model, signal, onProgress });
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || !isTransientPullError(error) || attempt === maxAttempts) throw error;
      const nextAttempt = attempt + 1;
      onProgress({
        status: `Network interrupted; retrying download (${nextAttempt}/${maxAttempts})`,
        retrying: true,
        retryAttempt: nextAttempt,
        retryLimit: maxAttempts,
      });
      await retryDelay(Number(retryDelays[attempt - 1]) || 0, signal);
    }
  }
  throw lastError;
}

async function modelIdentity({ baseUrl, model, signal }) {
  const requested = normalizedModel(model);
  const models = await listModels({ baseUrl, signal });
  const entry = models.find((candidate) => [candidate.name, candidate.model].filter(Boolean)
    .some((value) => normalizedModel(value) === requested));
  if (!entry) throw Object.assign(new Error(`Ollama model ${model} is not installed`), { statusCode: 409 });
  return { model, resolvedModel: entry.name || entry.model, digest: entry.digest || null, size: Number(entry.size) || null };
}

async function embed({ baseUrl, model, texts, keepAlive = '5m', signal }) {
  const input = Array.isArray(texts) ? texts : [texts];
  const payload = await request(baseUrl, '/api/embed', {
    body: { model, input, truncate: false, keep_alive: keepAlive }, signal, timeoutMs: 120000,
  });
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== input.length) {
    throw new Error('Ollama returned an invalid embeddings response');
  }
  return { embeddings: payload.embeddings, metrics: {
    totalDuration: payload.total_duration || null, loadDuration: payload.load_duration || null,
    promptEvalCount: payload.prompt_eval_count || null,
  } };
}

function hardwareOptions(preference, options) {
  if (preference === 'cpu') return { ...options, num_gpu: 0 };
  if (preference === 'gpu') return { ...options, num_gpu: 999 };
  return options;
}

function extractJson(content) {
  const value = String(content || '').trim();
  try { return JSON.parse(value); } catch { /* Try a fenced or embedded object. */ }
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced.trim()); } catch { /* Continue. */ }
  }
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(value.slice(first, last + 1)); } catch { /* Report a stable error below. */ }
  }
  const error = new Error('Ollama returned invalid structured output');
  error.code = 'OLLAMA_INVALID_JSON';
  throw error;
}

async function chat({ baseUrl, model, messages, schema, tools, think = false, options = {},
  hardwarePreference = 'auto', keepAlive = '5m', signal, timeoutMs = 300000 }) {
  return generationQueue.run(async () => {
    const payload = await request(baseUrl, '/api/chat', {
      body: {
        model, messages, stream: false, think,
        ...(schema ? { format: schema } : {}),
        ...(tools ? { tools } : {}),
        keep_alive: keepAlive,
        options: hardwareOptions(hardwarePreference, {
          num_ctx: 8192,
          num_batch: 256,
          num_predict: think ? 3200 : 1800,
          temperature: think ? 0.6 : 0.2,
          top_p: think ? 0.95 : 0.8,
          top_k: 20,
          min_p: 0,
          ...options,
        }),
      }, signal, timeoutMs,
    });
    return {
      content: String(payload?.message?.content || '').trim(),
      thinking: '',
      toolCalls: Array.isArray(payload?.message?.tool_calls) ? payload.message.tool_calls : [],
      metrics: {
        totalDuration: payload.total_duration || null, loadDuration: payload.load_duration || null,
        promptEvalCount: payload.prompt_eval_count || null, promptEvalDuration: payload.prompt_eval_duration || null,
        evalCount: payload.eval_count || null, evalDuration: payload.eval_duration || null,
      },
    };
  }, signal);
}

async function chatJson(options) {
  let attemptOptions = options;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await chat(attemptOptions);
    try {
      return { value: extractJson(result.content), metrics: { ...result.metrics, structuredRetries: attempt } };
    } catch (error) {
      if (error?.code !== 'OLLAMA_INVALID_JSON') throw error;
      if (attempt === 1) break;

      const originalOptions = options.options || {};
      const originalPredictionBudget = Math.max(256, Number(originalOptions.num_predict) || (options.think ? 3200 : 1800));
      attemptOptions = {
        ...options,
        messages: [
          ...(options.messages || []),
          { role: 'system', content: 'Your previous response was malformed or incomplete JSON. Regenerate the complete answer from the same evidence. Return exactly one valid JSON object matching the supplied schema, with no Markdown fences or text outside the object.' },
        ],
        options: {
          ...originalOptions,
          num_predict: Math.min(4096, Math.max(originalPredictionBudget + 512, Math.ceil(originalPredictionBudget * 1.5))),
          temperature: Math.min(0.2, Number(originalOptions.temperature ?? (options.think ? 0.6 : 0.2))),
          top_p: Math.min(0.75, Number(originalOptions.top_p ?? 0.8)),
        },
      };
    }
  }
  const error = new Error('The local model could not complete a valid answer structure after an automatic retry. Please regenerate the answer.');
  error.code = 'OLLAMA_INVALID_JSON';
  throw error;
}

async function unload({ baseUrl, model }) {
  if (!model) return;
  await request(baseUrl, '/api/generate', { body: { model, keep_alive: 0 }, timeoutMs: 30000 });
}

async function runtimeHealth({ baseUrl, chatModel, embeddingModel, signal }) {
  const [models, running] = await Promise.all([
    listModels({ baseUrl, signal }),
    request(baseUrl, '/api/ps', { method: 'GET', signal, timeoutMs: 15000 }).catch(() => ({ models: [] })),
  ]);
  const installed = new Map(models.map((model) => [normalizedModel(model.name || model.model), model]));
  const loaded = Array.isArray(running.models) ? running.models : [];
  return {
    available: true,
    chatModel: chatModel ? { installed: installed.has(normalizedModel(chatModel)), ...(installed.get(normalizedModel(chatModel)) || {}) } : { installed: false },
    embeddingModel: { installed: installed.has(normalizedModel(embeddingModel)), ...(installed.get(normalizedModel(embeddingModel)) || {}) },
    loaded: loaded.map((entry) => ({ name: entry.name || entry.model, size: entry.size, sizeVram: entry.size_vram, contextLength: entry.context_length })),
    host: { totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), architecture: os.arch(), platform: os.platform() },
    queueDepth: generationQueue.depth,
  };
}

module.exports = {
  normalizeBaseUrl, listModels, pullModel, modelIdentity, embed, chat, chatJson, unload, runtimeHealth, extractJson, generationQueue,
  isTransientPullError, explainPullError,
};
