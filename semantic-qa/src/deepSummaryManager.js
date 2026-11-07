const crypto = require('node:crypto');
const ollama = require('./ollama');
const { sha256 } = require('./corpusStructure');
const { sanitizeError } = require('./syncManager');

const MAX_DEEP_RECORDS = 100;
const DEFAULT_DEEP_RECORDS = 60;
const DEFAULT_DEEP_PARALLEL_REQUESTS = 1;
const MAX_DEEP_PARALLEL_REQUESTS = 1;
const DEFAULT_DEEP_REQUEST_TIMEOUT_MS = 600000;
const MAX_DEEP_REQUEST_TIMEOUT_MS = 600000;
const DEEP_JOB_TIMEOUT_MS = 45 * 60 * 1000;
const ADJUDICATION_BATCH_CHARACTERS = 42000;
const MAX_ADJUDICATION_CHARACTERS = 84000;
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
    elapsedSeconds: Math.max(0, Math.round((now - job.startedAtMs) / 1000)),
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
    result: job.result,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
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

function fuseMatches(resultSets, maximum) {
  const fused = new Map();
  const reserved = new Set();
  const perProbeQuota = Math.max(1, Math.floor(maximum / Math.max(1, resultSets.length)));
  for (const matches of resultSets) {
    for (let rank = 0; rank < matches.length; rank += 1) {
      const match = matches[rank];
      const key = String(match.sourceId);
      if (rank < perProbeQuota) reserved.add(key);
      const existing = fused.get(key) || { match, score: 0, ranks: 0, bestProbeRank: Number.POSITIVE_INFINITY };
      existing.score += 1 / (60 + rank + 1);
      existing.ranks += 1;
      existing.bestProbeRank = Math.min(existing.bestProbeRank, rank + 1);
      if (Number(match.relevanceScore || 0) > Number(existing.match.relevanceScore || 0)) existing.match = match;
      fused.set(key, existing);
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
    fusedProbeScore: score,
    matchedProbeCount: ranks,
    bestProbeRank,
  }));
}

function augmentDeepSearchProbes(question, planned) {
  const exactQuestion = String(question || '').trim();
  const probes = [exactQuestion];
  if (/\b(?:promotion|career|job|interview|workplace|professional)\b/iu.test(exactQuestion)) {
    probes.push(
      'Can a devotee pray to God for success in a job interview, competition, test, or career promotion?',
      'How can a devotee love God without aspiring for a practical worldly fruit or boon in return?',
      'Can a devotee ask God for a peaceful worldly life or protection from difficulties at work?',
      'Does God grant worldly benefits and fulfill desires requested in prayer?',
    );
  }
  probes.push(...(Array.isArray(planned) ? planned : []));
  return [...new Set(probes.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 6);
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

function selectAdjudicationUnits(units, evidence, maximumCharacters = MAX_ADJUDICATION_CHARACTERS) {
  const candidates = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item.answerUnitId) continue;
    const key = String(item.answerUnitId);
    const current = candidates.get(key) || {
      bestProbeRank: Number.POSITIVE_INFINITY,
      matchedProbeCount: 0,
      relevanceScore: 0,
      semanticSimilarity: 0,
    };
    current.bestProbeRank = Math.min(current.bestProbeRank, Number(item.bestProbeRank) || Number.POSITIVE_INFINITY);
    current.matchedProbeCount = Math.max(current.matchedProbeCount, Number(item.matchedProbeCount) || 0);
    current.relevanceScore = Math.max(current.relevanceScore, Number(item.relevanceScore) || 0);
    current.semanticSimilarity = Math.max(current.semanticSimilarity, Number(item.semanticSimilarity) || 0);
    candidates.set(key, current);
  }
  const sourceUnits = Array.isArray(units) ? units : [];
  const eligible = candidates.size
    ? sourceUnits.filter((unit) => candidates.has(String(unit.answerUnitId)))
    : sourceUnits;
  const ranked = eligible.map((unit) => {
    const signals = candidates.get(String(unit.answerUnitId)) || {};
    const length = String(unit.text || '').length;
    const bestProbeRank = Number(signals.bestProbeRank) || Number.POSITIVE_INFINITY;
    return {
      unit,
      cost: length + 500,
      priority: bestProbeRank + Math.log2(1 + length / 1000),
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
    publish(job);
  }

  function advance(job, amount = 1, operation = null) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    phase.processed = Math.min(phase.total, phase.processed + amount);
    job.phaseProcessed = phase.processed;
    if (operation) job.currentOperation = operation;
    publish(job);
  }

  function completePhase(job) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    phase.processed = phase.total;
    phase.status = 'completed';
    phase.finishedAt = new Date().toISOString();
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
    try {
      for (let attempt = 1; attempt <= MODEL_CALL_ATTEMPTS; attempt += 1) {
        try {
          return await callback();
        } catch (error) {
          throwIfStopped(job);
          const permanent = ['OLLAMA_MODEL_NOT_ALLOWED', 'OLLAMA_THINKING_REQUIRED'].includes(error?.code);
          if (attempt >= MODEL_CALL_ATTEMPTS || permanent) throw error;
          log(job, `${operation} failed once; retrying the same bounded model call.`);
          job.currentOperation = `${operation} · retry ${attempt + 1} of ${MODEL_CALL_ATTEMPTS}`;
          publish(job);
        }
      }
      throw new Error(`${operation} did not return a result`);
    }
    finally { job.activeRequests = 0; publish(job); }
  }

  async function run(job, config) {
    const deadline = setTimeout(() => {
      const error = new Error('Deep Search exceeded its 45-minute job limit');
      error.code = 'DEEP_SEARCH_DEADLINE';
      job.abortController.abort(error);
    }, DEEP_JOB_TIMEOUT_MS);
    deadline.unref?.();
    try {
      job.status = 'running';
      const common = {
        baseUrl: config.baseUrl,
        model: config.model,
        hardwarePreference: config.hardwarePreference,
        timeoutMs: Math.min(MAX_DEEP_REQUEST_TIMEOUT_MS, Math.max(60000, Number(config.requestTimeoutMs) || DEFAULT_DEEP_REQUEST_TIMEOUT_MS)),
        signal: job.abortController.signal,
      };

      beginPhase(job, 'plan', 1, `Checking thinking capability for ${config.model}`);
      await oneModelCall(job, `Checking thinking capability for ${config.model}`, () => requireThinking(common));
      const plannedProbes = await oneModelCall(job, 'Planning practical, principle, qualification, and counter-teaching probes', () => planProbes({ ...common, question: config.question }));
      const probes = augmentDeepSearchProbes(config.question, plannedProbes);
      advance(job, 1);
      completePhase(job);
      log(job, `Planned ${probes.length} focused probes without changing the user question.`);

      beginPhase(job, 'retrieve', probes.length, 'Searching citable teachings and non-citable discovery context');
      const resultSets = [Array.isArray(config.matches) ? config.matches : []];
      for (let index = 0; index < probes.length; index += 1) {
        throwIfStopped(job);
        const probe = probes[index];
        if (typeof config.retrieveProbe === 'function') resultSets.push(await config.retrieveProbe(probe, job.abortController.signal));
        advance(job, 1, `Searching probe ${index + 1} of ${probes.length}`);
      }
      const fusedMatches = fuseMatches(resultSets, Math.max(1, Math.min(MAX_DEEP_RECORDS, Number(config.maxRecords) || DEFAULT_DEEP_RECORDS)));
      const collected = collectCandidateEvidence(fusedMatches, config);
      completePhase(job);

      beginPhase(job, 'read', fusedMatches.length, 'Reconstructing complete Swami replies and teachings');
      let units = typeof config.readAnswerUnits === 'function'
        ? await config.readAnswerUnits(fusedMatches.map((match) => match.sourceId))
        : [];
      if (!units.length) units = fallbackUnits(collected.evidence);
      units = units.filter((unit) => String(unit.author || 'Swami') === 'Swami' && ['swami_reply', 'swami_teaching'].includes(unit.unitKind || 'swami_teaching'));
      const readUnits = units;
      const sourceIdsRead = [...new Set(readUnits.map((unit) => String(unit.sourceId)))];
      const selected = selectAdjudicationUnits(readUnits, collected.evidence);
      units = selected.units;
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

      const batches = batchesByCharacters(units);
      beginPhase(job, 'adjudicate', batches.length * 2, 'Running independent Qwen adjudication 1');
      const first = new Map();
      const second = new Map();
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
      const third = new Map();
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

      const adjudicated = units.map((unit) => {
        const left = first.get(unit.answerUnitId);
        const right = second.get(unit.answerUnitId);
        const decision = third.get(unit.answerUnitId) || (left?.classification === right?.classification ? left : null);
        return { unit, decision };
      });
      const accepted = adjudicated.filter(({ decision }) => decision && decision.classification !== 'irrelevant' && decision.contextComplete === true &&
        (decision.classification !== 'illustration' || decision.storyComplete === true)).map((item) => {
        const sourceQuestion = item.unit.associatedQuestion || item.unit.title || '';
        if (item.decision.classification !== 'direct_answer' || isLiteralDirectQuestionMatch(config.question, sourceQuestion)) return item;
        return {
          ...item,
          decision: {
            ...item.decision,
            classification: 'governing_principle',
            relationship: item.decision.relationship || 'This teaching governs the question without literally asking the same thing.',
          },
        };
      });

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
        const unitValid = unit.author === 'Swami' && exact === unit.text && hashValid && item.decision.contextComplete &&
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
          disagreements: disagreements.length,
          finalVerification: verified.length,
          scannedPassages: Number(config.retrievalCoverage?.scannedPassages) || 0,
        },
      };
      job.processed = job.total;
      job.status = 'completed';
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
      job.status = cancelled ? 'cancelled' : 'failed';
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
    }
  }

  function start(config) {
    const id = `deep_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      id, status: 'queued', phase: 'queued', currentOperation: 'Queued', processed: 0, total: 1,
      phaseProcessed: 0, phaseTotal: 0, activeRequests: 0,
      hardwarePreference: ollama.normalizeHardwarePreference(config.hardwarePreference), hardware: null,
      phases: DEEP_PHASE_DEFINITIONS.map((phase) => ({ ...phase, status: 'pending', processed: 0, total: 0, startedAt: null, finishedAt: null })),
      currentPhaseId: null, error: null, result: null, startedAtMs: Date.now(), abortController: new AbortController(),
      logs: [], listeners: new Set(), createdAt: new Date().toISOString(), finishedAt: null,
    };
    jobs.set(id, job);
    job.heartbeat = setInterval(() => { if (job.status === 'running') publish(job); }, 1000);
    job.heartbeat.unref?.();
    queueMicrotask(() => void run(job, { ...config, hardwarePreference: job.hardwarePreference }));
    return publicJob(job);
  }

  function get(id) { return jobs.has(id) ? publicJob(jobs.get(id)) : null; }
  function cancel(id) {
    const job = jobs.get(id);
    if (job && !job.abortController.signal.aborted) {
      const error = new Error('Deep Search cancelled');
      error.code = 'DEEP_SEARCH_CANCELLED';
      job.abortController.abort(error);
    }
    return job ? publicJob(job) : null;
  }
  function subscribe(id, response) {
    const job = jobs.get(id);
    if (!job) return false;
    job.listeners.add(response);
    response.write(`event: status\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
    return true;
  }
  function unsubscribe(id, response) { jobs.get(id)?.listeners.delete(response); }

  return { start, get, cancel, subscribe, unsubscribe, _jobs: jobs };
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
};
