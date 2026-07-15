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
  const [embedding] = await embedTexts({ ...config, texts: ['semantic-qa connectivity test'] });
  return { ok: true, model: config.model, dimension: embedding.length };
}

module.exports = { normalizeOllamaBaseUrl, embedTexts, testOllama };
