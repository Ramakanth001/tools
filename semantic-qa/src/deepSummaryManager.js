const crypto = require('node:crypto');
const ollama = require('./ollama');
const { extractRequestedPhrases } = require('./core');
const { sanitizeError } = require('./syncManager');

const MAX_DEEP_RECORDS = 100;
const DEFAULT_DEEP_RECORDS = 60;
const DEFAULT_DEEP_PARALLEL_REQUESTS = 2;
const MAX_DEEP_PARALLEL_REQUESTS = 4;
const DEFAULT_DEEP_REQUEST_TIMEOUT_MS = 300000;
const MAX_DEEP_REQUEST_TIMEOUT_MS = 900000;
const VALIDATION_BATCH_SIZE = 12;
const CLAIM_BATCH_SIZE = 8;
const CONSOLIDATION_BATCH_SIZE = 12;
const MAX_SYNTHESIS_CLAIMS = 24;
const DEEP_PHASE_DEFINITIONS = [
  { id: 'collect', name: 'Collect candidate evidence', weight: 2, unit: 'passages' },
  { id: 'validate', name: 'Validate evidence relevance', weight: 42, unit: 'passages' },
  { id: 'extract', name: 'Extract grounded points', weight: 30, unit: 'passages' },
  { id: 'pool', name: 'Pool overlapping evidence', weight: 15, unit: 'groups' },
  { id: 'write', name: 'Write evidence-faithful summary', weight: 10, unit: 'answer' },
  { id: 'cite', name: 'Resolve evidence citations', weight: 1, unit: 'citations' },
];

function normalizedText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function phasePercent(phase) {
  if (['completed', 'skipped'].includes(phase.status)) return 100;
  if (!phase.total) return 0;
  return Math.min(100, Math.round((phase.processed / phase.total) * 100));
}

function phaseUsesOllama(phase) {
  return ['validate', 'extract', 'pool', 'write'].includes(phase.id);
}

function progressSnapshot(job) {
  const now = Date.now();
  const phaseProgress = (job.phases || []).map((phase) => ({ ...phase, percent: phasePercent(phase) }));
  const weighted = phaseProgress.reduce((total, phase) => total + (phase.weight * phase.percent) / 100, 0);
  const overallPercent = job.status === 'completed' ? 100 : Math.min(99, Math.round(weighted));
  const elapsedSeconds = Math.max(0, Math.round((now - job.startedAtMs) / 1000));
  let etaSeconds = null;
  let secondsPerWeight = job.secondsPerWeight ?? null;
  const observedModelWeight = phaseProgress
    .filter(phaseUsesOllama)
    .reduce((total, phase) => total + (phase.weight * phase.percent) / 100, 0);
  if (job.status === 'running' && job.modelProgressObserved && observedModelWeight > 0 && job.modelWorkStartedAtMs) {
    const modelElapsedSeconds = Math.max(0.001, (now - job.modelWorkStartedAtMs) / 1000);
    const rawSecondsPerWeight = modelElapsedSeconds / observedModelWeight;
    if (job.lastEtaModelWeight !== observedModelWeight) {
      secondsPerWeight = secondsPerWeight == null
        ? rawSecondsPerWeight
        : (secondsPerWeight * 0.65) + (rawSecondsPerWeight * 0.35);
      job.secondsPerWeight = secondsPerWeight;
      job.lastEtaModelWeight = observedModelWeight;
    }
  }
  if (job.status === 'running' && secondsPerWeight != null) {
    const remainingModelWeight = phaseProgress
      .filter(phaseUsesOllama)
      .reduce((total, phase) => {
        if (['completed', 'skipped'].includes(phase.status)) return total;
        return total + phase.weight * (1 - phase.percent / 100);
      }, 0);
    etaSeconds = remainingModelWeight > 0
      ? Math.min(86400, Math.max(1, Math.ceil(remainingModelWeight * secondsPerWeight)))
      : 0;
    job.etaSeconds = etaSeconds;
  } else if (job.status === 'completed') {
    etaSeconds = 0;
  }
  const phases = phaseProgress.map((phase) => {
    const startedAtMs = phase.startedAt ? Date.parse(phase.startedAt) : null;
    const finishedAtMs = phase.finishedAt ? Date.parse(phase.finishedAt) : null;
    const phaseElapsedSeconds = startedAtMs
      ? Math.max(0, Math.round(((finishedAtMs || now) - startedAtMs) / 1000))
      : 0;
    if (!phaseUsesOllama(phase) || secondsPerWeight == null) {
      return { ...phase, elapsedSeconds: phaseElapsedSeconds, etaSeconds: phase.status === 'completed' ? 0 : null, estimatedDurationSeconds: phase.status === 'completed' ? phaseElapsedSeconds : null };
    }
    const remainingWeight = ['completed', 'skipped'].includes(phase.status)
      ? 0
      : phase.weight * (1 - phase.percent / 100);
    const phaseEtaSeconds = phase.status === 'running'
      ? (remainingWeight > 0 ? Math.max(1, Math.ceil(remainingWeight * secondsPerWeight)) : 0)
      : null;
    const estimatedDurationSeconds = phase.status === 'completed'
      ? phaseElapsedSeconds
      : phase.status === 'skipped'
        ? 0
        : phase.status === 'running'
          ? phaseElapsedSeconds + phaseEtaSeconds
          : Math.max(1, Math.ceil(phase.weight * secondsPerWeight));
    return { ...phase, elapsedSeconds: phaseElapsedSeconds, etaSeconds: phaseEtaSeconds, estimatedDurationSeconds };
  });
  return {
    phases,
    overallPercent,
    elapsedSeconds,
    etaSeconds,
    estimatedTotalSeconds: etaSeconds == null ? null : elapsedSeconds + etaSeconds,
    estimatedCompletionAt: etaSeconds > 0 ? new Date(Date.now() + etaSeconds * 1000).toISOString() : null,
  };
}

function publicJob(job) {
  const progress = progressSnapshot(job);
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    processed: job.processed,
    total: job.total,
    percent: job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0,
    phaseProcessed: job.phaseProcessed,
    phaseTotal: job.phaseTotal,
    phasePercent: job.phaseTotal ? Math.min(100, Math.round((job.phaseProcessed / job.phaseTotal) * 100)) : 0,
    parallelism: job.parallelism,
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

function collectCandidateEvidence(matches, { searchMode, threshold, question = '', retrievalCoverage = {} }) {
  const requestedPhrases = extractRequestedPhrases(question);
  const evidence = [];
  const seen = new Set();
  for (const match of (Array.isArray(matches) ? matches : [])) {
    const passage = Array.isArray(match.matchedPassages) ? match.matchedPassages[0] : null;
    if (!passage?.text) continue;
    const key = normalizedText(passage.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const score = Number(match.relevanceScore ?? match.searchScore ?? match.similarity) || 0;
    const similarity = Number(match.similarity) || 0;
    const normalizedPassage = normalizedText(passage.text);
    const preservesRequestedPhrase = !requestedPhrases.length || requestedPhrases.every((phrase) => normalizedPassage.includes(phrase));
    // Text rank widens recall but does not establish meaning or answerability.
    // Conventional candidates must therefore pass the independent verifier.
    const automaticallyAccepted = searchMode === 'search'
      ? false
      : score >= Number(threshold) && similarity >= 0.30 && preservesRequestedPhrase;
    const exploratoryEligible = searchMode === 'search'
      ? score >= 0.04
      : similarity >= 0.25 && score >= Number(threshold) - 0.18;
    if (!automaticallyAccepted && !exploratoryEligible) continue;
    evidence.push({
      sourceId: match.sourceId,
      sourceGroup: match.sourceGroup ?? null,
      sourceOrder: match.sourceOrder ?? null,
      sourceTitle: String(match.question || '').trim() || null,
      question: match.question,
      text: passage.text,
      start: passage.start,
      end: passage.end,
      relevanceScore: score,
      semanticSimilarity: similarity,
      matchChannels: match.matchChannels || passage.matchChannels || [],
      automaticallyAccepted,
    });
  }
  return {
    evidence,
    retrievedCandidates: Array.isArray(matches) ? matches.length : 0,
    exhaustive: Boolean(retrievalCoverage.exhaustive),
    scannedPassages: Number(retrievalCoverage.scannedPassages) || 0,
  };
}

function createDeepSummaryManager({
  validateEvidence = ollama.validateEvidenceBatch,
  extractClaims = ollama.extractGroundedClaims,
  consolidateClaims = ollama.consolidateGroundedClaims,
  synthesize = ollama.synthesizeDeepAnswer,
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
    if (job.logs.length > 100) job.logs.shift();
    publish(job, 'log');
  }

  function cancelled(job) {
    if (!job.cancelRequested) return false;
    const error = new Error('Deep summary cancelled');
    error.code = 'DEEP_SUMMARY_CANCELLED';
    throw error;
  }

  function beginPhase(job, phaseId, total = 0) {
    const phase = job.phases.find((item) => item.id === phaseId);
    if (!phase) throw new Error(`Unknown deep summary phase: ${phaseId}`);
    phase.status = 'running';
    phase.processed = 0;
    phase.total = Math.max(0, Number(total) || 0);
    phase.startedAt = phase.startedAt || new Date().toISOString();
    if (phaseUsesOllama(phase) && !job.modelWorkStartedAtMs) job.modelWorkStartedAtMs = Date.now();
    job.currentPhaseId = phaseId;
    job.phase = phase.name;
    job.phaseProcessed = phase.processed;
    job.phaseTotal = phase.total;
  }

  function updatePhase(job, processed, total = null) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    if (!phase) return;
    if (total != null) phase.total = Math.max(0, Number(total) || 0);
    phase.processed = Math.max(0, Math.min(phase.total || Number(processed) || 0, Number(processed) || 0));
    job.phaseProcessed = phase.processed;
    job.phaseTotal = phase.total;
  }

  function addPhaseWork(job, amount) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    if (!phase) return;
    phase.total += Math.max(0, Number(amount) || 0);
    job.phaseTotal = phase.total;
  }

  function incrementPhase(job, amount) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    if (!phase) return;
    phase.processed = Math.min(phase.total, phase.processed + Math.max(0, Number(amount) || 0));
    job.phaseProcessed = phase.processed;
    job.phaseTotal = phase.total;
    job.modelProgressObserved = true;
  }

  function completePhase(job, phaseId = job.currentPhaseId) {
    const phase = job.phases.find((item) => item.id === phaseId);
    if (!phase) return;
    if (!phase.total) phase.total = 1;
    phase.processed = phase.total;
    phase.status = 'completed';
    phase.finishedAt = new Date().toISOString();
    if (job.currentPhaseId === phaseId) {
      job.phaseProcessed = phase.processed;
      job.phaseTotal = phase.total;
    }
  }

  function skipPendingPhases(job) {
    for (const phase of job.phases) {
      if (phase.status === 'pending') {
        phase.status = 'skipped';
        phase.finishedAt = new Date().toISOString();
      }
    }
  }

  function stopCurrentPhase(job, status) {
    const phase = job.phases.find((item) => item.id === job.currentPhaseId);
    if (phase?.status === 'running') {
      phase.status = status;
      phase.finishedAt = new Date().toISOString();
    }
  }

  function boundedInteger(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed))) : fallback;
  }

  async function refreshHardware(job, config) {
    if (typeof inspectHardware !== 'function') return;
    try {
      job.hardware = await inspectHardware({ baseUrl: config.baseUrl, model: config.model });
      const processor = job.hardware?.runtime?.processor;
      if (processor) log(job, `Ollama summary model processor: ${processor}.`);
    } catch (error) {
      log(job, `Could not inspect Ollama processor allocation (${sanitizeError(error)}).`);
    }
  }

  function recoverableOllamaError(error, label) {
    return new RegExp(`timed out|empty chat response|invalid json for ${label}`, 'iu').test(String(error?.message || ''));
  }

  function batchesOf(items, batchSize) {
    const batches = [];
    for (let index = 0; index < items.length; index += batchSize) batches.push({ items: items.slice(index, index + batchSize), offset: index });
    return batches;
  }

  async function mapConcurrent(job, items, concurrency, worker, onComplete = () => {}) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let cursor = 0;
    let firstError = null;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!firstError) {
        cancelled(job);
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        job.activeRequests += 1;
        publish(job);
        let completed = false;
        try {
          results[index] = await worker(items[index], index);
          completed = true;
        } catch (error) {
          firstError ||= error;
        } finally {
          job.activeRequests = Math.max(0, job.activeRequests - 1);
        }
        if (completed) onComplete(items[index], results[index], index);
        publish(job);
      }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
    return results;
  }

  async function validateEvidenceResilient(job, config, batch) {
    try {
      return await validateEvidence({
        baseUrl: config.baseUrl, model: config.model, question: config.question, evidence: batch,
        hardwarePreference: config.hardwarePreference,
        timeoutMs: config.requestTimeoutMs,
      });
    } catch (error) {
      cancelled(job);
      if (!recoverableOllamaError(error, 'deep evidence validation')) throw error;
      if (batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2);
        log(job, `Evidence validation was interrupted; retrying ${batch.length} passages as ${midpoint} + ${batch.length - midpoint}.`);
        const left = await validateEvidenceResilient(job, config, batch.slice(0, midpoint));
        const right = await validateEvidenceResilient(job, config, batch.slice(midpoint));
        return [...left, ...right.map((number) => number + midpoint)];
      }
      log(job, `Skipping source ${batch[0]?.sourceId || 'unknown'} after its individual evidence validation remained unavailable (${sanitizeError(error)}).`);
      return [];
    }
  }

  async function extractClaimsResilient(job, config, batch, evidenceOffset) {
    try {
      const extracted = await extractClaims({
        baseUrl: config.baseUrl, model: config.model, question: config.question, evidence: batch,
        hardwarePreference: config.hardwarePreference,
        timeoutMs: config.requestTimeoutMs,
      });
      const normalized = (Array.isArray(extracted) ? extracted : []).flatMap((claim) => {
        const text = String(claim?.text || '').trim();
        const evidenceNumbers = [...new Set((Array.isArray(claim?.evidenceNumbers) ? claim.evidenceNumbers : [])
          .map(Number)
          .filter((number) => Number.isInteger(number) && number >= 1 && number <= batch.length)
          .map((number) => evidenceOffset + number))];
        return text && evidenceNumbers.length ? [{ text, evidenceNumbers, fallback: false }] : [];
      });
      if (normalized.length) return normalized;
      throw new Error('Ollama returned no grounded claims for this evidence batch');
    } catch (error) {
      cancelled(job);
      if (!recoverableOllamaError(error, 'deep claim extraction') && !/no grounded claims/iu.test(String(error?.message || ''))) throw error;
      if (batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2);
        log(job, `Claim extraction batch could not be parsed; retrying ${batch.length} passages as smaller groups.`);
        const left = await extractClaimsResilient(job, config, batch.slice(0, midpoint), evidenceOffset);
        const right = await extractClaimsResilient(job, config, batch.slice(midpoint), evidenceOffset + midpoint);
        return [...left, ...right];
      }
      const text = String(batch[0]?.text || '').trim().slice(0, 1800);
      if (!text) return [];
      log(job, `Using the verified source passage directly after claim extraction remained unavailable for source ${batch[0].sourceId}.`);
      return [{ text, evidenceNumbers: [evidenceOffset + 1], fallback: true }];
    }
  }

  async function synthesizeResilient(job, config, claims) {
    let timeoutMs = config.requestTimeoutMs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await synthesize({
          baseUrl: config.baseUrl, model: config.model, question: config.question, claims, maxParagraphs: 8,
          hardwarePreference: config.hardwarePreference, timeoutMs,
        });
      } catch (error) {
        cancelled(job);
        if (attempt > 0 || !recoverableOllamaError(error, 'deep synthesis')) throw error;
        timeoutMs = Math.min(MAX_DEEP_REQUEST_TIMEOUT_MS, Math.max(timeoutMs + 60000, Math.round(timeoutMs * 1.5)));
        log(job, `Deep answer writing was interrupted; retrying once with a ${Math.round(timeoutMs / 1000)} second timeout.`);
      }
    }
    throw new Error('Deep answer writing remained unavailable');
  }

  async function consolidateForSynthesis(job, config, inputClaims) {
    let current = inputClaims;
    while (current.length > MAX_SYNTHESIS_CLAIMS) {
      log(job, `Pooling ${current.length} grounded claims into a smaller non-repetitive set for final writing.`);
      const claimBatches = batchesOf(current, CONSOLIDATION_BATCH_SIZE);
      addPhaseWork(job, claimBatches.length);
      const pooledBatches = await mapConcurrent(job, claimBatches, config.parallelRequests, async ({ items: batch }, batchIndex) => {
        let consolidated;
        try {
          consolidated = await consolidateClaims({
            baseUrl: config.baseUrl, model: config.model, question: config.question, claims: batch,
            hardwarePreference: config.hardwarePreference,
            timeoutMs: config.requestTimeoutMs,
          });
        } catch (error) {
          cancelled(job);
          log(job, `Claim pooling was unavailable for one batch; preserving it through deterministic pairwise pooling (${sanitizeError(error)}).`);
          consolidated = [];
          for (let pair = 0; pair < batch.length; pair += 2) {
            const pairClaims = batch.slice(pair, pair + 2);
            consolidated.push({
              text: pairClaims.map((claim) => claim.text).join(' '),
              claimNumbers: pairClaims.map((_claim, pairIndex) => pair + pairIndex + 1),
            });
          }
        }
        const normalized = [];
        for (const claim of consolidated) {
          const claimNumbers = [...new Set((Array.isArray(claim?.claimNumbers) ? claim.claimNumbers : [])
            .map(Number).filter((number) => Number.isInteger(number) && number >= 1 && number <= batch.length))];
          const text = String(claim?.text || '').trim();
          if (!text || !claimNumbers.length) continue;
          normalized.push({
            text,
            evidenceNumbers: [...new Set(claimNumbers.flatMap((claimNumber) => batch[claimNumber - 1]?.evidenceNumbers || []))],
          });
        }
        log(job, `Pooled claim group ${batchIndex + 1} of ${claimBatches.length}.`);
        return normalized;
      }, () => { incrementPhase(job, 1); });
      const next = pooledBatches.flat();
      if (!next.length) throw new Error('Grounded claim pooling returned no usable claims');
      if (next.length >= current.length) {
        const paired = [];
        for (let index = 0; index < current.length; index += 2) {
          const pair = current.slice(index, index + 2);
          paired.push({
            text: pair.map((claim) => claim.text).join(' '),
            evidenceNumbers: [...new Set(pair.flatMap((claim) => claim.evidenceNumbers))],
          });
        }
        current = paired;
      } else {
        current = next;
      }
    }
    return current;
  }

  async function run(job, config) {
    try {
      config.parallelRequests = boundedInteger(config.parallelRequests, 1, MAX_DEEP_PARALLEL_REQUESTS, DEFAULT_DEEP_PARALLEL_REQUESTS);
      config.requestTimeoutMs = boundedInteger(config.requestTimeoutMs, 60000, MAX_DEEP_REQUEST_TIMEOUT_MS, DEFAULT_DEEP_REQUEST_TIMEOUT_MS);
      config.hardwarePreference = ollama.normalizeHardwarePreference(config.hardwarePreference);
      job.hardwarePreference = config.hardwarePreference;
      job.parallelism = config.parallelRequests;
      job.status = 'running';
      beginPhase(job, 'collect', Array.isArray(config.matches) ? config.matches.length : 0);
      const collected = collectCandidateEvidence(config.matches, config);
      updatePhase(job, Array.isArray(config.matches) ? config.matches.length : 0);
      completePhase(job, 'collect');
      const accepted = collected.evidence.filter((item) => item.automaticallyAccepted);
      const exploratory = collected.evidence.filter((item) => !item.automaticallyAccepted);
      job.total = Math.max(1, exploratory.length + collected.evidence.length + 1);
      beginPhase(job, 'validate', exploratory.length);
      const validationBatches = batchesOf(exploratory, VALIDATION_BATCH_SIZE);
      log(job, `Inspecting ${collected.evidence.length} candidate passages from ${new Set(collected.evidence.map((item) => item.sourceId)).size} records with up to ${config.parallelRequests} parallel Ollama requests.`);

      const validationResults = await mapConcurrent(job, validationBatches, config.parallelRequests, async ({ items: batch }) => ({
        batch,
        acceptedNumbers: await validateEvidenceResilient(job, config, batch),
      }), ({ items: batch }) => {
        job.processed += batch.length;
        incrementPhase(job, batch.length);
      });
      for (const { batch, acceptedNumbers } of validationResults) {
        for (const number of [...new Set(acceptedNumbers)]) {
          if (Number.isInteger(number) && number >= 1 && number <= batch.length) accepted.push(batch[number - 1]);
        }
      }
      completePhase(job, 'validate');
      if (exploratory.length) await refreshHardware(job, config);
      log(job, `Verified ${accepted.length} of ${collected.evidence.length} relevance-qualified passages for grounded claim extraction.`);
      if (!accepted.length) {
        job.status = 'completed';
        skipPendingPhases(job);
        job.phase = 'Complete';
        job.processed = job.total;
        job.result = {
          status: 'not_available', reason: 'no_verified_evidence', paragraphs: [], evidence: [],
          coverage: {
            scannedPassages: collected.scannedPassages,
            retrievedCandidates: collected.retrievedCandidates,
            candidateRecords: collected.evidence.length,
            verifiedRecords: 0,
            rejectedRecords: collected.evidence.length,
            exhaustiveScan: collected.exhaustive,
          },
        };
        job.finishedAt = new Date().toISOString();
        publish(job, 'status');
        return;
      }

      beginPhase(job, 'extract', accepted.length);
      let fallbackClaimCount = 0;
      const claimBatches = batchesOf(accepted, CLAIM_BATCH_SIZE);
      const extractedBatches = await mapConcurrent(job, claimBatches, config.parallelRequests, async ({ items: batch, offset }) =>
        extractClaimsResilient(job, config, batch, offset), ({ items: batch }) => {
        job.processed += batch.length;
        incrementPhase(job, batch.length);
      });
      const claims = [];
      for (const extracted of extractedBatches) {
        for (const claim of extracted) {
          if (claim.fallback) fallbackClaimCount += 1;
          claims.push({
            text: claim.text,
            evidenceNumbers: claim.evidenceNumbers,
          });
        }
      }
      if (!claims.length) throw new Error('No grounded claims could be extracted from the verified evidence');
      completePhase(job, 'extract');
      if (!job.hardware) await refreshHardware(job, config);

      beginPhase(job, 'pool', 0);
      const synthesisClaims = await consolidateForSynthesis(job, config, claims);
      completePhase(job, 'pool');

      beginPhase(job, 'write', 1);
      cancelled(job);
      const synthesis = await synthesizeResilient(job, config, synthesisClaims);
      updatePhase(job, 1);
      completePhase(job, 'write');

      beginPhase(job, 'cite', synthesisClaims.length);
      const paragraphs = synthesis.paragraphs.map((paragraph) => ({
        text: paragraph.text,
        evidenceNumbers: [...new Set(paragraph.claimNumbers.flatMap((claimNumber) => synthesisClaims[claimNumber - 1]?.evidenceNumbers || []))]
          .filter((number) => number >= 1 && number <= accepted.length),
      })).filter((paragraph) => paragraph.evidenceNumbers.length);
      const usedClaimNumbers = new Set(synthesis.paragraphs.flatMap((paragraph) => paragraph.claimNumbers || []));
      const omittedClaims = synthesisClaims
        .map((claim, index) => ({ ...claim, claimNumber: index + 1 }))
        .filter((claim) => !usedClaimNumbers.has(claim.claimNumber));
      for (let index = 0; index < omittedClaims.length; index += 3) {
        const group = omittedClaims.slice(index, index + 3);
        paragraphs.push({
          text: group.map((claim) => claim.text).join(' '),
          evidenceNumbers: [...new Set(group.flatMap((claim) => claim.evidenceNumbers || []))]
            .filter((number) => number >= 1 && number <= accepted.length),
        });
      }
      if (!paragraphs.length) throw new Error('Deep summary citations did not resolve to original evidence');
      updatePhase(job, synthesisClaims.length);
      completePhase(job, 'cite');

      const usedEvidence = new Set(paragraphs.flatMap((paragraph) => paragraph.evidenceNumbers));
      job.processed = job.total;
      job.phase = 'Complete';
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      job.result = {
        status: 'ready',
        mode: 'deep',
        title: synthesis.title,
        paragraphs,
        evidence: accepted.map((item, index) => ({ ...item, evidenceNumber: index + 1, usedInSummary: usedEvidence.has(index + 1) })),
        coverage: {
          scannedPassages: collected.scannedPassages,
          retrievedCandidates: collected.retrievedCandidates,
          exhaustiveScan: collected.exhaustive,
          candidateRecords: collected.evidence.length,
          automaticallyAcceptedRecords: collected.evidence.filter((item) => item.automaticallyAccepted).length,
          verifiedExpandedRecords: accepted.filter((item) => !item.automaticallyAccepted).length,
          verifiedRecords: accepted.length,
          rejectedRecords: collected.evidence.length - accepted.length,
          claimCount: claims.length,
          pooledClaimCount: synthesisClaims.length,
          supplementalClaimParagraphs: Math.ceil(omittedClaims.length / 3),
          fallbackClaimCount,
          usedSourceCount: new Set(accepted.filter((_item, index) => usedEvidence.has(index + 1)).map((item) => String(item.sourceId))).size,
        },
      };
      log(job, `Completed with ${accepted.length} verified evidence passages and ${claims.length} grounded claims.`);
      publish(job, 'status');
    } catch (error) {
      job.status = error?.code === 'DEEP_SUMMARY_CANCELLED' ? 'cancelled' : 'failed';
      stopCurrentPhase(job, job.status);
      job.phase = job.status;
      job.error = sanitizeError(error);
      job.finishedAt = new Date().toISOString();
      log(job, job.error);
      publish(job, 'status');
    } finally {
      for (const listener of [...job.listeners]) { try { listener.end(); } catch { /* ignore */ } }
      job.listeners.clear();
    }
  }

  function start(config) {
    const id = `deep_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      id, status: 'queued', phase: 'queued', processed: 0, total: 0, error: null, result: null,
      phaseProcessed: 0, phaseTotal: 0,
      parallelism: boundedInteger(config.parallelRequests, 1, MAX_DEEP_PARALLEL_REQUESTS, DEFAULT_DEEP_PARALLEL_REQUESTS), activeRequests: 0,
      hardwarePreference: ollama.normalizeHardwarePreference(config.hardwarePreference), hardware: null,
      phases: DEEP_PHASE_DEFINITIONS.map((phase) => ({ ...phase, status: 'pending', processed: 0, total: 0, startedAt: null, finishedAt: null })),
      currentPhaseId: null, modelProgressObserved: false, etaSeconds: null, secondsPerWeight: null,
      lastEtaModelWeight: null, modelWorkStartedAtMs: null, startedAtMs: Date.now(),
      logs: [], listeners: new Set(), cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null,
    };
    jobs.set(id, job);
    queueMicrotask(() => void run(job, config));
    return publicJob(job);
  }

  function get(id) { return jobs.has(id) ? publicJob(jobs.get(id)) : null; }
  function cancel(id) { const job = jobs.get(id); if (job) job.cancelRequested = true; return job ? publicJob(job) : null; }
  function subscribe(id, response) {
    const job = jobs.get(id); if (!job) return false;
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
  collectCandidateEvidence,
  createDeepSummaryManager,
  publicJob,
};
