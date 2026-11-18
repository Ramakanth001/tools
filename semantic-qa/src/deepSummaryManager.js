const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const ollama = require('./ollama');
const { sha256, isCitableSwamiUnit } = require('./corpusStructure');
const { sanitizeError } = require('./syncManager');

const MAX_DEEP_RECORDS = 100;
const DEFAULT_DEEP_RECORDS = 60;
const DEFAULT_DEEP_PARALLEL_REQUESTS = 1;
const MAX_DEEP_PARALLEL_REQUESTS = 1;
const DEFAULT_DEEP_REQUEST_TIMEOUT_MS = 600000;
const MAX_DEEP_REQUEST_TIMEOUT_MS = 1200000;
const DEEP_JOB_TIMEOUT_MS = 90 * 60 * 1000;
const ADJUDICATION_BATCH_CHARACTERS = 4500;
const MAX_READING_UNIT_CHARACTERS = 3500;
const MAX_ADJUDICATION_CHARACTERS = 28000;
const MAX_ADJUDICATION_UNITS = 20;
const MODEL_CALL_ATTEMPTS = 2;

const DEEP_PHASE_DEFINITIONS = [
  { id: 'plan', name: 'Plan semantic probes', weight: 8, unit: 'probes' },
  { id: 'retrieve', name: 'Search teachings and discovery context', weight: 18, unit: 'probes' },
  { id: 'read', name: 'Read complete Swami answers', weight: 18, unit: 'sources' },
  { id: 'adjudicate', name: 'Independently adjudicate teachings', weight: 34, unit: 'reviews' },
  { id: 'cluster', name: 'Build distinct teaching clusters', weight: 10, unit: 'teachings' },
  { id: 'verify', name: 'Verify verbatim source spans', weight: 12, unit: 'teachings' },
];

function normalizedText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

const DIRECT_MATCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'can', 'could', 'do', 'does', 'for', 'from',
  'give', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'should',
  'that', 'the', 'this', 'to', 'we', 'what', 'when', 'why', 'with', 'you', 'your',
]);

function directMatchTokens(value) {
  return normalizedText(value).match(/[\p{L}\p{N}]+/gu)?.filter((token) => (
    token.length >= 3 && !DIRECT_MATCH_STOP_WORDS.has(token)
  )) || [];
}

function isLiteralDirectQuestionMatch(question, sourceQuestion) {
  const queryText = normalizedText(question);
  const candidateText = normalizedText(sourceQuestion);
  if (!queryText || !candidateText) return false;
  if (queryText === candidateText) return true;
  const queryTokens = [...new Set(directMatchTokens(queryText))];
  const candidateTokens = new Set(directMatchTokens(candidateText));
  if (queryTokens.length < 2) return false;
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
  return overlap / queryTokens.length >= 0.75;
}

function phasePercent(phase) {
  if (['completed', 'skipped'].includes(phase.status)) return 100;
  if (!phase.total) return 0;
  return Math.min(100, Math.round((phase.processed / phase.total) * 100));
}

function roundedMilliseconds(value) {
  return Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
}

function metricsSnapshot(job, { includeCandidateIds = job.status === 'completed' } = {}) {
  const metrics = job.metrics || {};
  const candidateFlow = { ...(metrics.candidateFlow || {}) };
  if (!includeCandidateIds) delete candidateFlow.candidateAnswerUnitIds;
  return {
    queueDurationMs: metrics.queueDurationMs == null ? null : roundedMilliseconds(metrics.queueDurationMs),
    modelLoadDurationMs: roundedMilliseconds(metrics.modelLoadDurationMs),
    promptEvalDurationMs: roundedMilliseconds(metrics.promptEvalDurationMs),
    generationDurationMs: roundedMilliseconds(metrics.generationDurationMs),
    terminationReason: job.terminationReason || null,
    phases: Object.fromEntries(Object.entries(metrics.phases || {}).map(([id, phase]) => [id, {
      durationMs: phase.durationMs == null ? null : roundedMilliseconds(phase.durationMs),
      processed: Number(phase.processed) || 0,
      total: Number(phase.total) || 0,
    }])),
    modelCalls: (metrics.modelCalls || []).map((call) => ({ ...call, durationMs: roundedMilliseconds(call.durationMs) })),
    probeRetrievals: (metrics.probeRetrievals || []).map((probe) => ({ ...probe, durationMs: roundedMilliseconds(probe.durationMs) })),
    tokenUsage: {
      prompt: Number(metrics.tokenUsage?.prompt) || 0,
      completion: Number(metrics.tokenUsage?.completion) || 0,
      total: (Number(metrics.tokenUsage?.prompt) || 0) + (Number(metrics.tokenUsage?.completion) || 0),
    },
    candidateFlow,
  };
}

function progressSnapshot(job) {
  const now = Date.now();
  const phases = job.phases.map((phase) => ({
    ...phase,
    percent: phasePercent(phase),
    elapsedSeconds: phase.startedAt
      ? Math.max(0, Math.round(((phase.finishedAt ? Date.parse(phase.finishedAt) : now) - Date.parse(phase.startedAt)) / 1000))
      : 0,
    etaSeconds: null,
    estimatedDurationSeconds: null,
  }));
  const weighted = phases.reduce((total, phase) => total + (phase.weight * phase.percent) / 100, 0);
  return {
    phases,
    overallPercent: job.status === 'completed' ? 100 : Math.min(99, Math.round(weighted)),
    elapsedSeconds: Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : now) - job.startedAtMs) / 1000)),
    etaSeconds: null,
    estimatedTotalSeconds: null,
    estimatedCompletionAt: null,
  };
}

function publicJob(job) {
  const progress = progressSnapshot(job);
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    currentOperation: job.currentOperation,
    processed: job.processed,
    total: job.total,
    percent: job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0,
    phaseProcessed: job.phaseProcessed,
    phaseTotal: job.phaseTotal,
    phasePercent: job.phaseTotal ? Math.min(100, Math.round((job.phaseProcessed / job.phaseTotal) * 100)) : 0,
    parallelism: 1,
    activeRequests: job.activeRequests,
    hardwarePreference: job.hardwarePreference,
    hardware: job.hardware,
    ...progress,
    error: job.error,
    logs: [...job.logs],
    metrics: metricsSnapshot(job),
    result: job.result,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    terminationReason: job.terminationReason || null,
  };
}

function collectCandidateEvidence(matches, { maxRecords = DEFAULT_DEEP_RECORDS, retrievalCoverage = {} } = {}) {
  const evidence = [];
  const seen = new Set();
  const candidateLimit = Math.max(1, Math.min(MAX_DEEP_RECORDS, Math.trunc(Number(maxRecords)) || DEFAULT_DEEP_RECORDS));
  const sourceMatches = Array.isArray(matches) ? matches : [];
  const availablePassages = sourceMatches.reduce((total, match) => (
    total + (Array.isArray(match.matchedPassages) ? match.matchedPassages.length : 0)
  ), 0);
  const maximumPassages = sourceMatches.reduce((maximum, match) => (
    Math.max(maximum, Array.isArray(match.matchedPassages) ? match.matchedPassages.length : 0)
  ), 0);
  for (let passageIndex = 0; passageIndex < maximumPassages; passageIndex += 1) {
    for (const match of sourceMatches) {
      const passage = Array.isArray(match.matchedPassages) ? match.matchedPassages[passageIndex] : null;
      if (!passage) continue;
      const exactText = String(passage.citationText || passage.text || '');
      const key = passage.answerUnitId || `${match.sourceId}:${passage.citationStart ?? passage.start}:${passage.citationEnd ?? passage.end}:${normalizedText(exactText)}`;
      if (!exactText.trim() || seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        sourceId: String(match.sourceId),
        sourceGroup: match.sourceGroup ?? match.sourceId,
        sourceTitle: String(match.question || '').trim() || null,
        answerUnitId: passage.answerUnitId || match.answerUnitId || null,
        author: passage.author || match.author || 'Swami',
        unitKind: passage.unitKind || match.unitKind || 'swami_teaching',
        associatedQuestion: passage.associatedQuestion || '',
        text: exactText,
        start: Number.isInteger(passage.citationStart) ? passage.citationStart : Number(passage.start) || 0,
        end: Number.isInteger(passage.citationEnd) ? passage.citationEnd : Number(passage.end) || exactText.length,
        contextComplete: passage.contextComplete !== false,
        storyComplete: passage.storyComplete !== false,
        relevanceScore: Number(match.relevanceScore ?? match.searchScore ?? match.similarity) || 0,
        semanticSimilarity: Number(passage.semanticSimilarity ?? match.similarity) || 0,
        matchChannels: match.matchChannels || passage.matchChannels || [],
        bestProbeRank: Number(match.bestProbeRank) || Number.POSITIVE_INFINITY,
        matchedProbeCount: Number(match.matchedProbeCount) || 0,
        originalQueryRank: Number(match.originalQueryRank) || Number.POSITIVE_INFINITY,
      });
      if (evidence.length >= candidateLimit) break;
    }
    if (evidence.length >= candidateLimit) break;
  }
  return {
    evidence,
    candidateLimit,
    candidatesTruncated: evidence.length >= candidateLimit && evidence.length < availablePassages,
    retrievedCandidates: Array.isArray(matches) ? matches.length : 0,
    exhaustive: Boolean(retrievalCoverage.exhaustive),
    scannedPassages: Number(retrievalCoverage.scannedPassages) || 0,
  };
}

function mergePassages(existingPassages, newPassages) {
  const merged = new Map();
  const makeKey = (p) => (p.answerUnitId ? String(p.answerUnitId) : `${p.start}:${p.end}:${p.text}`);

  for (const p of (Array.isArray(existingPassages) ? existingPassages : [])) {
    if (p) merged.set(makeKey(p), { ...p });
  }

  for (const p of (Array.isArray(newPassages) ? newPassages : [])) {
    if (!p) continue;
    const key = makeKey(p);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...p });
    } else {
      merged.set(key, {
        ...prev,
        relevanceScore: Math.max(Number(prev.relevanceScore || 0), Number(p.relevanceScore || 0)),
        semanticSimilarity: Math.max(Number(prev.semanticSimilarity || 0), Number(p.semanticSimilarity || 0)),
        matchChannels: [...new Set([...(prev.matchChannels || []), ...(p.matchChannels || [])])],
      });
    }
  }

  return [...merged.values()].sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));
}

function fuseMatches(resultSets, maximum) {
  const fused = new Map();
  const reserved = new Set();
  const perProbeQuota = Math.max(1, Math.floor(maximum / Math.max(1, resultSets.length)));
  for (const matches of resultSets) {
    for (let rank = 0; rank < matches.length; rank += 1) {
      const match = matches[rank];
      const key = String(match.sourceId);
      if (rank < perProbeQuota) reserved.add(key);
      const existing = fused.get(key);
      if (!existing) {
        fused.set(key, {
          match: {
            ...match,
            matchedPassages: Array.isArray(match.matchedPassages) ? [...match.matchedPassages] : [],
          },
          score: 1 / (60 + rank + 1),
          ranks: 1,
          bestProbeRank: rank + 1,
        });
      } else {
        existing.score += 1 / (60 + rank + 1);
        existing.ranks += 1;
        existing.bestProbeRank = Math.min(existing.bestProbeRank, rank + 1);
        const mergedPassages = mergePassages(existing.match.matchedPassages, match.matchedPassages);
        const baseMatch = Number(match.relevanceScore || 0) > Number(existing.match.relevanceScore || 0) ? match : existing.match;
        existing.match = {
          ...baseMatch,
          relevanceScore: Math.max(Number(existing.match.relevanceScore || 0), Number(match.relevanceScore || 0)),
          matchedPassages: mergedPassages,
        };
      }
    }
  }
  const sorted = [...fused.values()].sort((left, right) => (
    right.score - left.score || right.ranks - left.ranks ||
    String(left.match.sourceId).localeCompare(String(right.match.sourceId))
  ));
  return [
    ...sorted.filter((entry) => reserved.has(String(entry.match.sourceId))),
    ...sorted.filter((entry) => !reserved.has(String(entry.match.sourceId))),
  ].slice(0, maximum).map(({ match, score, ranks, bestProbeRank }) => ({
    ...match,
    originalQueryRank: (resultSets[0] || []).findIndex((item) => String(item.sourceId) === String(match.sourceId)) + 1 || Number.POSITIVE_INFINITY,
    fusedProbeScore: score,
    matchedProbeCount: ranks,
    bestProbeRank,
  }));
}

function augmentDeepSearchProbes(question, planned) {
  const exactQuestion = String(question || '').trim();
  const rawPlanned = Array.isArray(planned) ? planned : [];
  const normalizedExact = exactQuestion.toLowerCase();

  const probes = [];
  const seen = new Set();
  if (exactQuestion) {
    probes.push(exactQuestion);
    seen.add(normalizedExact);
  }
  for (const item of rawPlanned) {
    const probe = String(item || '').trim();
    if (!probe) continue;
    const norm = probe.toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      probes.push(probe);
    }
  }
  return probes.slice(0, 6);
}

function batchesByCharacters(units, maximumCharacters = ADJUDICATION_BATCH_CHARACTERS) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const unit of units) {
    const length = String(unit.text || '').length + 500;
    if (current.length && size + length > maximumCharacters) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function fallbackUnits(evidence) {
  return evidence.map((item, index) => ({
    ...item,
    answerUnitId: item.answerUnitId || `${item.sourceId}:legacy:${index + 1}`,
    unitIndex: index + 1,
    displayText: item.text,
    start: 0,
    end: item.text.length,
    contentHash: sha256(item.text),
  }));
}

function boundedReadingUnit(unit, question, maximum = MAX_READING_UNIT_CHARACTERS) {
  const text = String(unit.text || '');
  if (text.length <= maximum) return unit;
  const paragraphs = [...text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/gu)];
  const tokens = [...new Set(directMatchTokens(question))];
  const ranked = paragraphs.map((match) => ({ match, score: tokens.filter((token) => directMatchTokens(match[0]).includes(token)).length / Math.sqrt(Math.max(1, match[0].length / 500)) }))
    .filter(({ match }) => match[0].length <= maximum)
    .sort((a, b) => b.score - a.score || a.match.index - b.match.index);
  if (!ranked.length) return null; // Never cut an oversized paragraph mid-sentence.
  const anchor = ranked[0].match;
  const index = paragraphs.indexOf(anchor);
  let first = index;
  let last = index;
  while (last + 1 < paragraphs.length && paragraphs[last + 1].index + paragraphs[last + 1][0].length - paragraphs[first].index <= maximum) last++;
  while (first > 0 && paragraphs[last].index + paragraphs[last][0].length - paragraphs[first - 1].index <= maximum) first--;
  const offset = paragraphs[first].index;
  const excerpt = text.slice(offset, paragraphs[last].index + paragraphs[last][0].length);
  return { ...unit, text: excerpt, displayText: unit.displayText ?? text, start: unit.start + offset, end: unit.start + offset + excerpt.length, contentHash: sha256(excerpt), readingTruncated: true };
}

function selectAdjudicationUnits(
  units,
  evidence,
  maximumCharacters = MAX_ADJUDICATION_CHARACTERS,
  maximumUnits = MAX_ADJUDICATION_UNITS,
  question = '',
) {
  const candidates = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item.answerUnitId) continue;
    const key = String(item.answerUnitId);
    const current = candidates.get(key) || {
      bestProbeRank: Number.POSITIVE_INFINITY,
      matchedProbeCount: 0,
      relevanceScore: 0,
      semanticSimilarity: 0,
      originalQueryRank: Number.POSITIVE_INFINITY,
    };
    current.bestProbeRank = Math.min(current.bestProbeRank, Number(item.bestProbeRank) || Number.POSITIVE_INFINITY);
    current.matchedProbeCount = Math.max(current.matchedProbeCount, Number(item.matchedProbeCount) || 0);
    current.relevanceScore = Math.max(current.relevanceScore, Number(item.relevanceScore) || 0);
    current.semanticSimilarity = Math.max(current.semanticSimilarity, Number(item.semanticSimilarity) || 0);
    current.originalQueryRank = Math.min(current.originalQueryRank, Number(item.originalQueryRank) || Number.POSITIVE_INFINITY);
    candidates.set(key, current);
  }
  const sourceUnits = Array.isArray(units) ? units : [];
  const eligible = (candidates.size
    ? sourceUnits.filter((unit) => candidates.has(String(unit.answerUnitId)))
    : sourceUnits).filter((unit) => isCitableSwamiUnit(unit));
  const ranked = eligible.map((unit) => boundedReadingUnit(unit, question)).filter(Boolean).map((unit) => {
    const signals = candidates.get(String(unit.answerUnitId)) || {};
    const length = String(unit.text || '').length;
    const bestProbeRank = Number(signals.bestProbeRank) || Number.POSITIVE_INFINITY;
    return {
      unit,
      cost: length + 500,
      priority: (Number(signals.originalQueryRank) <= 3 ? -200 + Number(signals.originalQueryRank) : 0) + (question && isLiteralDirectQuestionMatch(question, unit.associatedQuestion || unit.title) ? -100 : 0) + bestProbeRank + Math.log2(1 + length / 1000),
      matchedProbeCount: Number(signals.matchedProbeCount) || 0,
      relevanceScore: Number(signals.relevanceScore) || 0,
      semanticSimilarity: Number(signals.semanticSimilarity) || 0,
    };
  }).sort((left, right) => (
    left.priority - right.priority ||
    right.matchedProbeCount - left.matchedProbeCount ||
    right.relevanceScore - left.relevanceScore ||
    right.semanticSimilarity - left.semanticSimilarity ||
    String(left.unit.answerUnitId).localeCompare(String(right.unit.answerUnitId))
  ));
  const selected = [];
  let characters = 0;
  for (const item of ranked) {
    if (selected.length >= maximumUnits) break;
    if (selected.length && characters + item.cost > maximumCharacters) continue;
    selected.push(item.unit);
    characters += item.cost;
  }
  return { units: selected, characters, candidates: eligible.length };
}

function createDeepSummaryManager({
  requireThinking = ollama.requireThinkingModel,
  planProbes = ollama.planDeepSearchProbes,
  adjudicate = ollama.adjudicateTeachingUnits,
  inspectHardware = null,
} = {}) {
  const jobs = new Map();
  const queue = [];
  let activeJobId = null;

  function processQueue() {
    if (activeJobId !== null) {
      const activeJob = jobs.get(activeJobId);
      if (activeJob && activeJob.status === 'running') {
        return;
      }
      activeJobId = null;
    }

    while (queue.length > 0) {
      const next = queue.shift();
      const job = next.job;
      if (['cancelled', 'failed', 'completed'].includes(job.status)) {
        continue;
      }
      activeJobId = job.id;
      job.startedRunningAtMs = Date.now();
      job.metrics.queueDurationMs = Math.max(0, job.startedRunningAtMs - job.startedAtMs);
      queueMicrotask(() => void run(job, { ...next.config, hardwarePreference: job.hardwarePreference }));
      return;
    }
  }

  function publish(job, event = 'progress') {
    const payload = JSON.stringify(publicJob(job));
    for (const listener of [...job.listeners]) {
      try { listener.write(`event: ${event}\ndata: ${payload}\n\n`); } catch { job.listeners.delete(listener); }
    }
  }

  function log(job, message) {
    job.logs.push(`[${new Date().toISOString()}] ${message}`);
    if (job.logs.length > 120) job.logs.shift();
    publish(job, 'log');
  }

  function throwIfStopped(job) {
    if (!job.abortController.signal.aborted) return;
    const reason = job.abortController.signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error('Deep Search cancelled');
    error.code = 'DEEP_SEARCH_CANCELLED';
    throw error;
  }

  function beginPhase(job, id, total, operation) {
    const phase = job.phases.find((item) => item.id === id);
    phase.status = 'running';
    phase.processed = 0;
    phase.total = Math.max(0, Number(total) || 0);
    phase.startedAt = new Date().toISOString();
    job.currentPhaseId = id;
    job.phase = phase.name;
    job.currentOperation = operation || phase.name;
    job.phaseProcessed = 0;
    job.phaseTotal = phase.total;
    job.metrics.phases[id] = { startedAtMs: performance.now(), durationMs: null, processed: 0, total: phase.total };
    publish(job);
  }

  function advance(job, amount = 1, operation = null) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    phase.processed = Math.min(phase.total, phase.processed + amount);
    if (job.metrics.phases[phase.id]) job.metrics.phases[phase.id].processed = phase.processed;
    job.phaseProcessed = phase.processed;
    if (operation) job.currentOperation = operation;
    publish(job);
  }

  function completePhase(job) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    phase.processed = phase.total;
    phase.status = 'completed';
    phase.finishedAt = new Date().toISOString();
    const timing = job.metrics.phases[phase.id];
    if (timing) {
      timing.durationMs = performance.now() - timing.startedAtMs;
      timing.processed = phase.processed;
      timing.total = phase.total;
    }
    job.phaseProcessed = phase.processed;
    publish(job);
  }

  function skipPending(job) {
    for (const phase of job.phases) if (phase.status === 'pending') phase.status = 'skipped';
  }

  async function oneModelCall(job, operation, callback) {
    throwIfStopped(job);
    job.activeRequests = 1;
    job.currentOperation = operation;
    publish(job);
    const startedAtMs = performance.now();
    let attempts = 0;
    let status = 'failed';
    try {
      for (let attempt = 1; attempt <= MODEL_CALL_ATTEMPTS; attempt += 1) {
        attempts = attempt;
        let onAbort = null;
        try {
          const callPromise = Promise.resolve().then(() => callback());
          const abortPromise = new Promise((_, reject) => {
            if (job.abortController.signal.aborted) {
              const reason = job.abortController.signal.reason;
              reject(reason instanceof Error ? reason : new Error('Deep Search cancelled'));
              return;
            }
            onAbort = () => {
              const reason = job.abortController.signal.reason;
              reject(reason instanceof Error ? reason : new Error('Deep Search cancelled'));
            };
            job.abortController.signal.addEventListener('abort', onAbort, { once: true });
          });
          const result = await Promise.race([callPromise, abortPromise]);
          status = 'succeeded';
          return result;
        } catch (error) {
          throwIfStopped(job);
          const permanent = ['OLLAMA_MODEL_NOT_ALLOWED', 'OLLAMA_THINKING_REQUIRED', 'OLLAMA_REQUEST_CANCELLED', 'DEEP_SEARCH_CANCELLED', 'DEEP_SEARCH_TIMEOUT'].includes(error?.code);
          if (attempt >= MODEL_CALL_ATTEMPTS || permanent) throw error;
          log(job, `${operation} failed once; retrying the same bounded model call.`);
          job.currentOperation = `${operation} · retry ${attempt + 1} of ${MODEL_CALL_ATTEMPTS}`;
          publish(job);
        } finally {
          if (onAbort) {
            job.abortController.signal.removeEventListener('abort', onAbort);
          }
        }
      }
      throw new Error(`${operation} did not return a result`);
    } finally {
      job.metrics.modelCalls.push({
        operation,
        attempts,
        status,
        durationMs: performance.now() - startedAtMs,
      });
      job.activeRequests = 0;
      publish(job);
    }
  }

  async function run(job, config) {
    const jobTimeoutMs = Number.isFinite(config.jobTimeoutMs) ? config.jobTimeoutMs : DEEP_JOB_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      const error = new Error('Deep Search timed out');
      error.code = 'DEEP_SEARCH_TIMEOUT';
      job.abortController.abort(error);
    }, jobTimeoutMs);
    deadline.unref?.();
    try {
      throwIfStopped(job);
      job.status = 'running';
      job.startedRunningAtMs = Date.now();
      job.metrics.queueDurationMs = Math.max(0, job.startedRunningAtMs - job.startedAtMs);
      const common = {
        baseUrl: config.baseUrl,
        model: config.model,
        hardwarePreference: config.hardwarePreference,
        timeoutMs: Math.min(MAX_DEEP_REQUEST_TIMEOUT_MS, Math.max(60000, Number(config.requestTimeoutMs) || DEFAULT_DEEP_REQUEST_TIMEOUT_MS)),
        signal: job.abortController.signal,
        onMetrics: (usage) => {
          job.metrics.tokenUsage.prompt += Number(usage?.promptTokens) || 0;
          job.metrics.tokenUsage.completion += Number(usage?.completionTokens) || 0;
          job.metrics.modelLoadDurationMs += (Number(usage?.loadDurationNs) || 0) / 1e6;
          job.metrics.promptEvalDurationMs += (Number(usage?.promptDurationNs) || 0) / 1e6;
          job.metrics.generationDurationMs += (Number(usage?.completionDurationNs) || 0) / 1e6;
        },
      };

      beginPhase(job, 'plan', 1, `Checking thinking capability for ${config.model}`);
      await oneModelCall(job, `Checking thinking capability for ${config.model}`, () => requireThinking(common));
      const plannedProbes = await oneModelCall(job, 'Planning practical, principle, qualification, and counter-teaching probes', () => planProbes({ ...common, question: config.question }));
      const probes = augmentDeepSearchProbes(config.question, plannedProbes);
      advance(job, 1);
      completePhase(job);
      log(job, `Planned ${probes.length} focused probes without changing the user question.`);

      beginPhase(job, 'retrieve', probes.length, 'Searching citable teachings and non-citable discovery context');
      const resultSets = [];
      const hasInitialMatches = Array.isArray(config.matches) && config.matches.length > 0;
      if (hasInitialMatches) {
        resultSets.push(config.matches);
      }

      const pendingProbes = [];
      for (let index = 0; index < probes.length; index += 1) {
        const probe = probes[index];
        if (index === 0 && hasInitialMatches && probe.toLowerCase() === String(config.question || '').trim().toLowerCase()) {
          job.metrics.probeRetrievals.push({
            probeNumber: 1,
            resultCount: config.matches.length,
            durationMs: 0,
            reusedInitial: true,
          });
          advance(job, 1, `Reusing initial search results for probe 1 of ${probes.length}`);
        } else {
          pendingProbes.push({ index, probe });
        }
      }

      if (pendingProbes.length > 0) {
        throwIfStopped(job);
        if (typeof config.retrieveProbes === 'function') {
          const probeStrings = pendingProbes.map((p) => p.probe);
          const retrievalStartedAtMs = performance.now();
          const batchResults = await config.retrieveProbes(probeStrings, job.abortController.signal);
          const totalDurationMs = performance.now() - retrievalStartedAtMs;
          const avgDuration = totalDurationMs / pendingProbes.length;
          for (let i = 0; i < pendingProbes.length; i += 1) {
            const matches = Array.isArray(batchResults[i]) ? batchResults[i] : [];
            resultSets.push(matches);
            job.metrics.probeRetrievals.push({
              probeNumber: pendingProbes[i].index + 1,
              resultCount: matches.length,
              durationMs: avgDuration,
            });
            advance(job, 1, `Searching probe ${pendingProbes[i].index + 1} of ${probes.length}`);
          }
        } else if (typeof config.retrieveProbe === 'function') {
          for (const { index, probe } of pendingProbes) {
            throwIfStopped(job);
            const retrievalStartedAtMs = performance.now();
            const matches = await config.retrieveProbe(probe, job.abortController.signal);
            resultSets.push(matches);
            job.metrics.probeRetrievals.push({
              probeNumber: index + 1,
              resultCount: Array.isArray(matches) ? matches.length : 0,
              durationMs: performance.now() - retrievalStartedAtMs,
            });
            advance(job, 1, `Searching probe ${index + 1} of ${probes.length}`);
          }
        }
      }
      const fusedMatches = fuseMatches(resultSets, Math.max(1, Math.min(MAX_DEEP_RECORDS, Number(config.maxRecords) || DEFAULT_DEEP_RECORDS)));
      const collected = collectCandidateEvidence(fusedMatches, config);
      job.metrics.candidateFlow = {
        probes: probes.length,
        rawRetrievedMatches: resultSets.reduce((total, set) => total + set.length, 0),
        fusedSources: fusedMatches.length,
        candidatePassages: collected.evidence.length,
        candidateAnswerUnitIds: [...new Set(collected.evidence.map((item) => item.answerUnitId).filter(Boolean))],
        candidatesTruncated: collected.candidatesTruncated,
      };
      completePhase(job);

      beginPhase(job, 'read', fusedMatches.length, 'Reconstructing complete Swami replies and teachings');
      let units = typeof config.readAnswerUnits === 'function'
        ? await config.readAnswerUnits(fusedMatches.map((match) => match.sourceId))
        : [];
      if (!units.length) units = fallbackUnits(collected.evidence);
      units = units.filter((unit) => isCitableSwamiUnit(unit) && ['swami_reply', 'swami_teaching'].includes(unit.unitKind || 'swami_teaching'));
      const readUnits = units;
      const sourceIdsRead = [...new Set(readUnits.map((unit) => String(unit.sourceId)))];
      const maxUnits = config.deliberation === 'fast' ? 10 : (config.deliberation === 'adaptive' ? 14 : MAX_ADJUDICATION_UNITS);
      const maxChars = config.deliberation === 'fast' ? 14000 : (config.deliberation === 'adaptive' ? 20000 : MAX_ADJUDICATION_CHARACTERS);
      const selected = selectAdjudicationUnits(readUnits, collected.evidence, maxChars, maxUnits, config.question);
      units = selected.units;
      Object.assign(job.metrics.candidateFlow, {
        sourcesRead: sourceIdsRead.length,
        answerUnitsRead: readUnits.length,
        answerUnitsAdjudicated: units.length,
        adjudicationCharacters: selected.characters,
      });
      advance(job, fusedMatches.length);
      completePhase(job);
      log(job, `Read ${readUnits.length} complete citable Swami answer units from ${sourceIdsRead.length} sources; shortlisted ${units.length} units (${selected.characters} characters) for bounded adjudication.`);

      if (!units.length) {
        skipPending(job);
        job.result = {
          status: 'not_available', mode: 'deep', answerStatus: 'insufficient', reason: 'no_citable_swami_units',
          notice: 'No responsibly relevant Swami teaching was found.', paragraphs: [], teachingClusters: [], evidence: [],
          audit: { probes: probes.length, sourcesRead: 0, rejectedEvidence: collected.evidence.length, disagreements: 0, finalVerification: 0 },
        };
        job.status = 'completed';
        job.phase = 'Complete';
        job.currentOperation = 'Complete';
        job.finishedAt = new Date().toISOString();
        publish(job, 'status');
        return;
      }

      const deliberationMode = config.deliberation || 'maximum';
      const batches = batchesByCharacters(units);
      const first = new Map();
      const second = new Map();
      const third = new Map();
      let disagreementsCount = 0;

      if (deliberationMode === 'maximum') {
        beginPhase(job, 'adjudicate', batches.length * 2, 'Running independent Qwen adjudication 1');
        for (let index = 0; index < batches.length; index += 1) {
          const batch = batches[index];
          const decisions = await oneModelCall(job, `Independent adjudication 1 · batch ${index + 1} of ${batches.length}`, () => adjudicate({ ...common, question: config.question, units: batch, reviewer: 1 }));
          for (const decision of decisions) first.set(decision.answerUnitId, decision);
          advance(job, 1);
        }
        for (let index = 0; index < batches.length; index += 1) {
          const batch = batches[index];
          const decisions = await oneModelCall(job, `Independent adjudication 2 · batch ${index + 1} of ${batches.length}`, () => adjudicate({ ...common, question: config.question, units: batch, reviewer: 2 }));
          for (const decision of decisions) second.set(decision.answerUnitId, decision);
          advance(job, 1);
        }
        const disagreements = units.filter((unit) => {
          const left = first.get(unit.answerUnitId);
          const right = second.get(unit.answerUnitId);
          return !left || !right || left.classification !== right.classification || left.contextComplete !== right.contextComplete || left.storyComplete !== right.storyComplete;
        });
        disagreementsCount = disagreements.length;
        if (disagreements.length) {
          const disagreementBatches = batchesByCharacters(disagreements);
          job.phases.find((phase) => phase.id === 'adjudicate').total += disagreementBatches.length;
          job.phaseTotal += disagreementBatches.length;
          for (let index = 0; index < disagreementBatches.length; index += 1) {
            const batch = disagreementBatches[index];
            const decisions = await oneModelCall(job, `Resolving adjudication disagreements · batch ${index + 1} of ${disagreementBatches.length}`, () => adjudicate({ ...common, question: config.question, units: batch, reviewer: 3 }));
            for (const decision of decisions) third.set(decision.answerUnitId, decision);
            advance(job, 1);
          }
        }
        completePhase(job);
      } else if (deliberationMode === 'adaptive') {
        beginPhase(job, 'adjudicate', batches.length, 'Running Qwen teaching unit adjudication');
        for (let index = 0; index < batches.length; index += 1) {
          const batch = batches[index];
          const decisions = await oneModelCall(job, `Adjudication · batch ${index + 1} of ${batches.length}`, () => adjudicate({ ...common, question: config.question, units: batch, reviewer: 1 }));
          for (const decision of decisions) first.set(decision.answerUnitId, decision);
          advance(job, 1);
        }

        const riskyUnits = units.filter((unit) => {
          const dec = first.get(unit.answerUnitId);
          if (!dec) return false;
          if (dec.classification === 'direct_answer') return true;
          if (dec.contextComplete === false || dec.storyComplete === false) return true;
          return false;
        });
        disagreementsCount = riskyUnits.length;

        if (riskyUnits.length > 0) {
          const riskyBatches = batchesByCharacters(riskyUnits);
          job.phases.find((phase) => phase.id === 'adjudicate').total += riskyBatches.length;
          job.phaseTotal += riskyBatches.length;
          for (let index = 0; index < riskyBatches.length; index += 1) {
            const batch = riskyBatches[index];
            const decisions = await oneModelCall(job, `Targeted critique of ${riskyUnits.length} candidate teaching units · batch ${index + 1} of ${riskyBatches.length}`, () => adjudicate({ ...common, question: config.question, units: batch, reviewer: 2 }));
            for (const decision of decisions) second.set(decision.answerUnitId, decision);
            advance(job, 1);
          }
        }
        completePhase(job);
      } else {
        beginPhase(job, 'adjudicate', batches.length, 'Running single-pass Qwen adjudication');
        for (let index = 0; index < batches.length; index += 1) {
          const batch = batches[index];
          const decisions = await oneModelCall(job, `Single-pass adjudication · batch ${index + 1} of ${batches.length}`, () => adjudicate({ ...common, question: config.question, units: batch, reviewer: 1 }));
          for (const decision of decisions) first.set(decision.answerUnitId, decision);
          advance(job, 1);
        }
        completePhase(job);
      }

      const adjudicated = units.map((unit) => {
        const left = first.get(unit.answerUnitId);
        const right = second.get(unit.answerUnitId);
        if (deliberationMode === 'maximum') {
          const decision = third.get(unit.answerUnitId) || (left?.classification === right?.classification ? left : null);
          return { unit, decision };
        }
        if (deliberationMode === 'adaptive') {
          if (right) {
            const isBothDirect = left?.classification === 'direct_answer' && right?.classification === 'direct_answer';
            const contextOk = left?.contextComplete !== false && right?.contextComplete !== false;
            const storyOk = left?.storyComplete !== false && right?.storyComplete !== false;
            const chosenDecision = isBothDirect ? right : (right.classification === 'irrelevant' ? right : right);
            return {
              unit,
              decision: {
                ...chosenDecision,
                contextComplete: contextOk,
                storyComplete: storyOk,
              },
            };
          }
          return { unit, decision: left };
        }
        return { unit, decision: left };
      });
      const accepted = adjudicated.filter(({ unit, decision }) => decision && !(unit.readingTruncated && decision.classification === 'illustration') && decision.classification !== 'irrelevant' && decision.contextComplete === true &&
        (decision.classification !== 'illustration' || decision.storyComplete === true));
      job.metrics.candidateFlow.acceptedAfterAdjudication = accepted.length;

      beginPhase(job, 'cluster', accepted.length, 'Grouping distinct teachings without rewriting them');
      const clusters = new Map();
      for (const item of accepted) {
        const label = String(item.decision.cluster || item.decision.classification.replace(/_/gu, ' ')).trim() || 'Related teaching';
        const key = normalizedText(label);
        if (!clusters.has(key)) clusters.set(key, { label, classification: item.decision.classification, items: [] });
        clusters.get(key).items.push(item);
        advance(job, 1);
      }
      completePhase(job);

      beginPhase(job, 'verify', accepted.length, 'Checking authors, hashes, and exact display-text offsets');
      const verified = [];
      for (const item of accepted) {
        const unit = item.unit;
        const displayText = String(unit.displayText ?? unit.text ?? '');
        const start = Number(unit.start);
        const end = Number(unit.end);
        const exact = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= displayText.length
          ? displayText.slice(start, end)
          : '';
        const hashValid = !unit.contentHash || sha256(String(unit.text || '')) === unit.contentHash;
        const unitValid = isCitableSwamiUnit(unit) && exact === unit.text && hashValid && item.decision.contextComplete &&
          (item.decision.classification !== 'illustration' || item.decision.storyComplete);
        if (unitValid) {
          const candidates = collected.evidence.filter((candidate) =>
            (candidate.answerUnitId && candidate.answerUnitId === unit.answerUnitId) ||
            (!candidate.answerUnitId && String(candidate.sourceId) === String(unit.sourceId)));
          const passage = candidates.find((candidate) => {
            const citationStart = Number(candidate.start);
            const citationEnd = Number(candidate.end);
            return candidate.author === 'Swami' && candidate.contextComplete !== false && candidate.storyComplete !== false &&
              Number.isInteger(citationStart) && Number.isInteger(citationEnd) &&
              citationStart >= start && citationEnd <= end && citationEnd > citationStart &&
              displayText.slice(citationStart, citationEnd) === candidate.text;
          });
          const selected = passage || {
            text: unit.text,
            start,
            end,
            contextComplete: true,
            storyComplete: item.decision.storyComplete,
          };
          verified.push({ ...item, selected });
        }
        advance(job, 1);
      }
      completePhase(job);
      job.metrics.candidateFlow.finalVerified = verified.length;

      const evidence = verified.map((item, index) => ({
        evidenceNumber: index + 1,
        sourceId: item.unit.sourceId,
        answerUnitId: item.unit.answerUnitId,
        sourceTitle: item.unit.title || null,
        author: item.unit.author,
        unitKind: item.unit.unitKind,
        associatedQuestion: item.unit.associatedQuestion || '',
        start: item.selected.start,
        end: item.selected.end,
        text: item.selected.text,
        contentHash: sha256(item.selected.text),
        answerUnitHash: item.unit.contentHash,
        contextComplete: item.selected.contextComplete !== false && item.decision.contextComplete,
        storyComplete: item.selected.storyComplete !== false && item.decision.storyComplete,
        classification: item.decision.classification,
        relationship: item.decision.relationship,
        cluster: item.decision.cluster,
      }));
      const evidenceNumberByUnit = new Map(evidence.map((item) => [item.answerUnitId, item.evidenceNumber]));
      const teachingClusters = [...clusters.values()].flatMap((cluster, index) => {
        const numbers = cluster.items.map((item) => evidenceNumberByUnit.get(item.unit.answerUnitId)).filter(Boolean);
        if (!numbers.length) return [];
        return [{
          id: `teaching-${index + 1}`,
          label: cluster.label,
          classification: cluster.classification,
          primaryEvidenceNumbers: numbers.slice(0, 2),
          additionalEvidenceNumbers: numbers.slice(2),
        }];
      });
      const usedEvidence = new Set(teachingClusters.flatMap((cluster) => cluster.primaryEvidenceNumbers));
      for (const item of evidence) item.usedInSummary = usedEvidence.has(item.evidenceNumber);
      const paragraphs = evidence.filter((item) => usedEvidence.has(item.evidenceNumber)).map((item) => ({ text: item.text, evidenceNumbers: [item.evidenceNumber] }));
      const answerStatus = evidence.some((item) => item.classification === 'direct_answer')
        ? 'direct'
        : evidence.length ? 'related_teachings' : 'insufficient';
      const notice = answerStatus === 'direct'
        ? 'Swami directly addresses this question in the teachings below.'
        : answerStatus === 'related_teachings'
          ? 'No literal answer was found. The following verified teachings meaningfully relate to the question.'
          : 'No responsibly relevant Swami teaching was found.';
      job.result = {
        status: evidence.length ? 'ready' : 'not_available',
        mode: 'deep',
        answerStatus,
        reason: evidence.length ? null : 'no_verified_evidence',
        notice,
        title: answerStatus === 'direct' ? 'Direct teaching' : answerStatus === 'related_teachings' ? 'Related teachings' : 'Insufficient evidence',
        paragraphs,
        teachingClusters,
        evidence,
        audit: {
          probes: probes.length,
          retrievedCandidates: resultSets.reduce((total, set) => total + set.length, 0),
          retrievedSourceIds: fusedMatches.map((match) => String(match.sourceId)),
          sourcesRead: sourceIdsRead.length,
          sourceIdsRead,
          answerUnitsRead: readUnits.length,
          answerUnitsAdjudicated: units.length,
          rejectedEvidence: units.length - verified.length,
          disagreements: disagreementsCount,
          finalVerification: verified.length,
          scannedPassages: Number(config.retrievalCoverage?.scannedPassages) || 0,
          retrievalCoverage: config.retrievalCoverage || {},
          performance: metricsSnapshot(job, { includeCandidateIds: true }),
        },
      };
      job.processed = job.total;
      job.status = 'completed';
      job.terminationReason = 'completed';
      job.phase = 'Complete';
      job.currentOperation = 'Complete';
      job.finishedAt = new Date().toISOString();
      if (typeof inspectHardware === 'function') {
        try { job.hardware = await inspectHardware({ baseUrl: config.baseUrl, model: config.model }); } catch { /* non-fatal */ }
      }
      log(job, `Completed with ${verified.length} exact verified teachings; discarded ${units.length - verified.length}.`);
      publish(job, 'status');
    } catch (error) {
      const cancelled = error?.code === 'DEEP_SEARCH_CANCELLED';
      const isTimeout = error?.code === 'DEEP_SEARCH_TIMEOUT';
      job.status = cancelled ? 'cancelled' : 'failed';
      job.activeRequests = 0;
      job.terminationReason = cancelled ? 'cancelled' : (isTimeout ? 'timeout' : (error?.code || error?.message || 'failed'));
      const phase = job.phases.find((item) => item.status === 'running');
      if (phase) { phase.status = job.status; phase.finishedAt = new Date().toISOString(); }
      job.phase = job.status;
      job.currentOperation = job.status;
      job.error = sanitizeError(error);
      job.finishedAt = new Date().toISOString();
      log(job, job.error);
      publish(job, 'status');
    } finally {
      clearTimeout(deadline);
      if (job.heartbeat) clearInterval(job.heartbeat);
      for (const listener of [...job.listeners]) { try { listener.end(); } catch { /* ignore */ } }
      job.listeners.clear();
      pruneJobs();
      if (activeJobId === job.id) {
        activeJobId = null;
      }
      processQueue();
    }
  }

  const MAX_STORED_JOBS = 20;
  const JOB_TTL_MS = 30 * 60 * 1000;

  function pruneJobs() {
    const now = Date.now();
    const completed = [];
    for (const [id, job] of jobs.entries()) {
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        const finishedMs = job.finishedAt ? Date.parse(job.finishedAt) : job.startedAtMs;
        if (now - finishedMs > JOB_TTL_MS) {
          jobs.delete(id);
        } else {
          completed.push({ id, finishedMs });
        }
      }
    }
    if (jobs.size > MAX_STORED_JOBS) {
      completed.sort((a, b) => a.finishedMs - b.finishedMs);
      while (jobs.size > MAX_STORED_JOBS && completed.length) {
        const oldest = completed.shift();
        jobs.delete(oldest.id);
      }
    }
  }

  function start(config) {
    pruneJobs();
    const id = `deep_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      id, status: 'queued', phase: 'queued', currentOperation: 'Queued', processed: 0, total: 1,
      phaseProcessed: 0, phaseTotal: 0, activeRequests: 0,
      hardwarePreference: ollama.normalizeHardwarePreference(config.hardwarePreference), hardware: null,
      phases: DEEP_PHASE_DEFINITIONS.map((phase) => ({ ...phase, status: 'pending', processed: 0, total: 0, startedAt: null, finishedAt: null })),
      currentPhaseId: null, error: null, result: null, startedAtMs: Date.now(), queuedAtMs: Date.now(), startedRunningAtMs: null,
      abortController: new AbortController(), terminationReason: null,
      logs: [], listeners: new Set(), createdAt: new Date().toISOString(), finishedAt: null,
      metrics: {
        queueDurationMs: null,
        modelLoadDurationMs: 0,
        promptEvalDurationMs: 0,
        generationDurationMs: 0,
        phases: {},
        modelCalls: [],
        probeRetrievals: [],
        tokenUsage: { prompt: 0, completion: 0 },
        candidateFlow: {},
      },
    };
    jobs.set(id, job);
    job.heartbeat = setInterval(() => { if (job.status === 'running') publish(job); }, 1000);
    job.heartbeat.unref?.();
    queue.push({ job, config });
    processQueue();
    return publicJob(job);
  }

  function get(id) { return jobs.has(id) ? publicJob(jobs.get(id)) : null; }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    const error = new Error('Deep Search cancelled');
    error.code = 'DEEP_SEARCH_CANCELLED';
    job.abortController.abort(error);
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.currentOperation = 'Cancelled';
    job.terminationReason = 'cancelled';
    job.activeRequests = 0;
    job.finishedAt = new Date().toISOString();
    const queueIdx = queue.findIndex((q) => q.job.id === id);
    if (queueIdx !== -1) {
      queue.splice(queueIdx, 1);
    }
    pruneJobs();
    publish(job, 'status');
    return publicJob(job);
  }

  function subscribe(id, response) {
    const job = jobs.get(id);
    if (!job) return false;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    job.listeners.add(response);
    response.write(`event: status\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
    return true;
  }

  function unsubscribe(id, response) {
    const job = jobs.get(id);
    if (job) job.listeners.delete(response);
  }

  return {
    start,
    get,
    cancel,
    subscribe,
    unsubscribe,
    getActiveJobId: () => activeJobId,
    getQueueLength: () => queue.length,
  };
}

module.exports = {
  DEFAULT_DEEP_RECORDS,
  DEFAULT_DEEP_PARALLEL_REQUESTS,
  MAX_DEEP_PARALLEL_REQUESTS,
  DEFAULT_DEEP_REQUEST_TIMEOUT_MS,
  MAX_DEEP_REQUEST_TIMEOUT_MS,
  MAX_DEEP_RECORDS,
  augmentDeepSearchProbes,
  collectCandidateEvidence,
  createDeepSummaryManager,
  fuseMatches,
  isLiteralDirectQuestionMatch,
  publicJob,
  selectAdjudicationUnits,
  batchesByCharacters,
  fallbackUnits,
  boundedReadingUnit,
};
