function normalizeOllamaBaseUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:11434'));
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Ollama URL must use a loopback host');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama URL must use HTTP or HTTPS');
  return url.toString().replace(/\/+$/, '');
}

async function ollamaRequest(baseUrl, path, body, timeoutMs = 120000) {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizedBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Ollama returned HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Ollama request timed out');
    if (error instanceof TypeError || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(error?.message || ''))) {
      throw new Error(`Cannot reach Ollama at ${normalizedBaseUrl}. Install/start Ollama and pull the configured embedding model.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModelReference(value) {
  const model = String(value || 'embeddinggemma').trim().toLocaleLowerCase();
  return model.includes(':') ? model : `${model}:latest`;
}

async function getModelIdentity({ baseUrl, model, timeoutMs = 30000 }) {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizedBaseUrl}/api/tags`, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Ollama returned HTTP ${response.status}`);
    const requested = normalizeModelReference(model);
    const models = Array.isArray(payload.models) ? payload.models : [];
    const entry = models.find((candidate) =>
      [candidate?.name, candidate?.model]
        .filter(Boolean)
        .some((value) => normalizeModelReference(value) === requested));
    if (!entry) throw new Error(`Ollama model ${String(model || 'embeddinggemma')} is not installed`);
    if (!entry.digest) throw new Error(`Ollama did not report a digest for model ${entry.name || entry.model}`);
    return {
      model: String(model || 'embeddinggemma'),
      resolvedModel: entry.name || entry.model,
      digest: String(entry.digest),
      modifiedAt: entry.modified_at || null,
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Ollama model identity request timed out');
    if (error instanceof TypeError || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(error?.message || ''))) {
      throw new Error(`Cannot reach Ollama at ${normalizedBaseUrl}. Install/start Ollama and pull the configured embedding model.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function embedTexts({ baseUrl, model, texts, timeoutMs }) {
  const input = Array.isArray(texts) ? texts : [texts];
  if (!input.length) return [];
  const payload = await ollamaRequest(baseUrl, '/api/embed', {
    model: String(model || 'embeddinggemma'),
    input,
    truncate: false,
  }, timeoutMs);
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== input.length) {
    throw new Error('Ollama returned an unexpected embeddings response');
  }
  return payload.embeddings;
}

async function testOllama(config) {
  const [identity, embeddings] = await Promise.all([
    getModelIdentity(config),
    embedTexts({ ...config, texts: ['semantic-qa connectivity test'] }),
  ]);
  return { ok: true, ...identity, dimension: embeddings[0].length };
}

module.exports = { normalizeOllamaBaseUrl, normalizeModelReference, getModelIdentity, embedTexts, testOllama };
