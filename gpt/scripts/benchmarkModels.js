const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const apiBase = String(process.env.GPT_BENCHMARK_API || 'http://127.0.0.1:8793/api').replace(/\/+$/, '');
const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eval/cases.json'), 'utf8'));
const ratingsPath = path.resolve(__dirname, '../eval/ratings.json');
const ratings = fs.existsSync(ratingsPath) ? JSON.parse(fs.readFileSync(ratingsPath, 'utf8')) : {};
const models = ['qwen3:14b-q4_K_M', 'qwen3:14b-q8_0'];
const seeds = [11, 29, 47];
const abstentionText = 'I could not find enough directly supporting evidence';

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function stream(pathname, body) {
  const response = await fetch(`${apiBase}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  const events = (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
  const failure = events.find((event) => event.type === 'error');
  if (failure) throw new Error(failure.error);
  return { answer: events.find((event) => event.type === 'answer')?.message, done: events.find((event) => event.type === 'done') };
}

function percentile(values, value) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1)];
}

function swapUsedBytes() {
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 3000 });
      const match = output.match(/used\s*=\s*([\d.]+)([KMG])/iu);
      if (!match) return null;
      return Number(match[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2].toUpperCase()]);
    }
    if (process.platform === 'linux') {
      const fields = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').map((line) => {
        const match = line.match(/^(SwapTotal|SwapFree):\s+(\d+)\s+kB$/u); return match ? [match[1], Number(match[2]) * 1024] : null;
      }).filter(Boolean));
      return Number.isFinite(fields.SwapTotal) && Number.isFinite(fields.SwapFree) ? fields.SwapTotal - fields.SwapFree : null;
    }
  } catch { /* Swap telemetry is diagnostic and must not abort an accuracy run. */ }
  return null;
}

async function memorySample(model) {
  const health = await api('/health').catch(() => null);
  const ollama = health?.checks?.ollama?.details;
  const loaded = (ollama?.loaded || []).filter((entry) => String(entry.name || '').toLocaleLowerCase().startsWith(model.toLocaleLowerCase().split('-q')[0]));
  return {
    totalBytes: Number(ollama?.host?.totalMemoryBytes) || os.totalmem(),
    freeBytes: Number(ollama?.host?.freeMemoryBytes) || os.freemem(),
    modelSizeBytes: Math.max(0, ...loaded.map((entry) => Number(entry.size) || 0)),
    modelVramBytes: Math.max(0, ...loaded.map((entry) => Number(entry.sizeVram) || 0)),
    swapUsedBytes: swapUsedBytes(),
  };
}

function aggregate(results, model, samples = []) {
  const positives = results.filter((result) => result.hasExpectedSources);
  const negatives = results.filter((result) => result.expectAbstention);
  const human = results.map((result) => result.human).filter(Boolean);
  const totalBytes = Math.max(0, ...samples.map((sample) => sample.totalBytes));
  const minimumFree = Math.min(...samples.map((sample) => sample.freeBytes).filter(Number.isFinite));
  const initialSwap = samples[0]?.swapUsedBytes;
  const peakSwap = Math.max(...samples.map((sample) => sample.swapUsedBytes).filter(Number.isFinite));
  return {
    cases: results.length,
    seeds,
    sourceRecall: positives.length ? positives.filter((result) => result.sourceHit).length / positives.length : null,
    correctAbstention: negatives.length ? negatives.filter((result) => result.abstained).length / negatives.length : null,
    citationSpanValidity: results.every((result) => result.citationsValid) ? 1 : results.filter((result) => result.citationsValid).length / results.length,
    groundedCorrectness: human.length ? human.reduce((sum, item) => sum + Number(item.groundedCorrectness || 0), 0) / human.length : null,
    citationSupport: human.length ? human.reduce((sum, item) => sum + Number(item.citationSupport || 0), 0) / human.length : null,
    unsupportedClaimRate: human.length ? human.reduce((sum, item) => sum + Number(item.unsupportedClaimRate || 0), 0) / human.length : null,
    latencyMs: {
      median: percentile(results.map((result) => result.latencyMs), 0.5),
      p95: percentile(results.filter((result) => !result.complex).map((result) => result.latencyMs), 0.95),
      complexP95: percentile(results.filter((result) => result.complex).map((result) => result.latencyMs), 0.95),
      retrievalP95: percentile(results.map((result) => result.retrievalMs), 0.95),
    },
    memory: {
      totalBytes,
      peakUsedBytes: Number.isFinite(minimumFree) ? totalBytes - minimumFree : null,
      peakPressureRatio: Number.isFinite(minimumFree) && totalBytes ? 1 - (minimumFree / totalBytes) : null,
      modelSizeBytes: Math.max(0, ...samples.map((sample) => sample.modelSizeBytes)),
      modelVramBytes: Math.max(0, ...samples.map((sample) => sample.modelVramBytes)),
      swapStartBytes: Number.isFinite(initialSwap) ? initialSwap : null,
      swapPeakBytes: Number.isFinite(peakSwap) ? peakSwap : null,
      swapGrowthBytes: Number.isFinite(initialSwap) && Number.isFinite(peakSwap) ? Math.max(0, peakSwap - initialSwap) : null,
    },
    model,
    requiresHumanReview: human.length !== results.length,
  };
}

function passesAbsolute(metrics) {
  return metrics.sourceRecall >= 0.95 && metrics.correctAbstention >= 0.95 && metrics.citationSpanValidity === 1 &&
    metrics.groundedCorrectness >= 0.90 && metrics.citationSupport >= 0.97 && metrics.unsupportedClaimRate <= 0.02 &&
    Number.isFinite(metrics.latencyMs.p95) && metrics.latencyMs.p95 <= 60000 &&
    Number.isFinite(metrics.latencyMs.complexP95) && metrics.latencyMs.complexP95 <= 90000 &&
    Number.isFinite(metrics.latencyMs.retrievalP95) && metrics.latencyMs.retrievalP95 <= 1500 &&
    metrics.memory.swapGrowthBytes != null && metrics.memory.swapGrowthBytes <= 1024 ** 3;
}

function chooseDefault(q4, q8) {
  if (!passesAbsolute(q4) && !passesAbsolute(q8)) return null;
  if (!passesAbsolute(q4)) return 'qwen3:14b-q8_0';
  if (!passesAbsolute(q8)) return 'qwen3:14b-q4_K_M';
  const qualityClose = q4.groundedCorrectness >= q8.groundedCorrectness - 0.01 &&
    q4.citationSupport >= q8.citationSupport - 0.01 && q4.unsupportedClaimRate <= q8.unsupportedClaimRate + 0.005;
  const latencyGain = q4.latencyMs.median <= q8.latencyMs.median * 0.8;
  const memoryGain = q4.memory.peakUsedBytes && q8.memory.peakUsedBytes && q4.memory.peakUsedBytes <= q8.memory.peakUsedBytes * 0.8;
  return qualityClose && (latencyGain || memoryGain) ? 'qwen3:14b-q4_K_M' : 'qwen3:14b-q8_0';
}

async function runModel(model, baseSettings) {
  const results = [];
  const samples = [await memorySample(model)];
  for (const seed of seeds) {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ ...baseSettings, chatModel: model, benchmarkSeed: seed }) });
    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index];
      const conversation = await api('/conversations', { method: 'POST', body: JSON.stringify({ title: `Benchmark ${model} ${seed} ${index + 1}` }) });
      const started = Date.now();
      const turn = await stream(`/conversations/${conversation.conversation.id}/messages`, { content: entry.question });
      const latencyMs = Date.now() - started;
      const sources = turn.answer?.sources || [];
      const sourceGroups = sources.map((source) => source.sourceGroup || source.sourceId);
      results.push({
        model, seed, question: entry.question, latencyMs,
        retrievalMs: Number(turn.done?.stats?.retrievalMs),
        complex: Boolean(entry.complex || /\b(compare|difference|contradict|conflict|reconcile|versus)\b/iu.test(entry.question)),
        hasExpectedSources: Boolean(entry.expectedSourceGroups?.length), expectAbstention: Boolean(entry.expectAbstention),
        sourceHit: !entry.expectedSourceGroups?.length || sourceGroups.some((group) => entry.expectedSourceGroups.includes(group)),
        abstained: String(turn.answer?.content || '').includes(abstentionText),
        citationsValid: sources.every((source) => Number.isInteger(source.passageIndex) && Number.isFinite(source.start) && Number.isFinite(source.end) && source.excerpt),
        human: ratings[`${model}|${seed}|${entry.question}`] || null,
      });
      samples.push(await memorySample(model));
      await api(`/conversations/${conversation.conversation.id}`, { method: 'DELETE' });
    }
  }
  return { metrics: aggregate(results, model, samples), results };
}

async function main() {
  if (cases.length < 150 && process.env.GPT_BENCHMARK_ALLOW_PARTIAL !== '1') {
    throw new Error(`Production benchmark requires at least 150 human-reviewed turns; ${cases.length} are currently checked in. Set GPT_BENCHMARK_ALLOW_PARTIAL=1 only for development.`);
  }
  const current = await api('/settings');
  const summaries = {};
  for (const model of models) {
    const run = await runModel(model, current.settings);
    summaries[model] = run.metrics;
    await api('/benchmarks', { method: 'POST', body: JSON.stringify({
      modelTag: model, status: 'complete', seeds, metrics: run.metrics,
      recommendation: run.metrics.requiresHumanReview ? 'pending-human-review' : null,
    }) });
  }
  const recommendation = chooseDefault(summaries[models[0]], summaries[models[1]]);
  if (recommendation) await api('/settings', { method: 'PUT', body: JSON.stringify({ ...current.settings, chatModel: recommendation, benchmarkSeed: null }) });
  process.stdout.write(`${JSON.stringify({ cases: cases.length, summaries, recommendation }, null, 2)}\n`);
  if (!recommendation) process.exitCode = 2;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = { aggregate, chooseDefault, passesAbsolute };
