const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('../src/corpusStructure');
const database = require('../src/database');
const { normalizeModelReference } = require('../src/ollama');
const { evaluationIndexConnection } = require('./deepSearchEvaluationConfig');

const DEFAULT_BENCHMARK = path.join(__dirname, '..', 'benchmark', 'deep_search_benchmark_queries.json');
const DEFAULT_API_BASE = 'http://127.0.0.1:8790/api';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const indexConnection = evaluationIndexConnection();

function percentile(values, target) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return sorted[index];
}

function groundTruthReviewFor(entry) {
  if (entry?.humanReview?.status === 'reviewed') return entry.humanReview;
  if (entry?.assistantReview?.status === 'reviewed') return entry.assistantReview;
  return null;
}

function validateBenchmark(document, { minimumReviewedCases = null } = {}) {
  const errors = [];
  const cases = Array.isArray(document?.cases) ? document.cases : [];
  const minimum = minimumReviewedCases ?? Math.max(1, Number(document?.minimumReviewedCases) || 50);
  const reviewed = cases.filter((entry) => groundTruthReviewFor(entry));
  const ids = new Set();

  if (!document || typeof document !== 'object') errors.push('Benchmark must be a JSON object.');
  if (!cases.length) errors.push('Benchmark has no cases.');
  for (const [index, entry] of cases.entries()) {
    const label = entry?.id || `case ${index + 1}`;
    if (!entry?.id || typeof entry.id !== 'string') errors.push(`${label}: id is required.`);
    else if (ids.has(entry.id)) errors.push(`${label}: id is duplicated.`);
    else ids.add(entry.id);
    if (!String(entry?.question || '').trim()) errors.push(`${label}: question is required.`);
    if (!String(entry?.category || '').trim()) errors.push(`${label}: category is required.`);
    const review = groundTruthReviewFor(entry);
    if (review) {
      if (!['direct', 'related_teachings', 'insufficient'].includes(review.answerStatus)) {
        errors.push(`${label}: ground-truth answerStatus must be direct, related_teachings, or insufficient.`);
      }
      if (!String(review.reviewedBy || '').trim()) errors.push(`${label}: ground-truth reviewedBy is required.`);
      const primary = [...new Set((review.primaryAnswerUnitIds || []).map(String))];
      const acceptable = [...new Set((review.acceptableAnswerUnitIds || []).map(String))];
      const forbidden = [...new Set((review.forbiddenAnswerUnitIds || []).map(String))];
      const overlaps = primary.filter((id) => acceptable.includes(id) || forbidden.includes(id))
        .concat(acceptable.filter((id) => forbidden.includes(id)));
      if (overlaps.length) errors.push(`${label}: human judgment lists overlap for ${[...new Set(overlaps)].join(', ')}.`);
      if (review.answerStatus !== 'insufficient' && !primary.length) {
        errors.push(`${label}: reviewed positive cases require at least one primaryAnswerUnitId.`);
      }
      if (review.answerStatus === 'insufficient' && (primary.length || acceptable.length)) {
        errors.push(`${label}: insufficient cases cannot contain primary or acceptable answer units.`);
      }
    }
  }
  if (reviewed.length < minimum) errors.push(`Only ${reviewed.length} reviewed cases are available; ${minimum} are required.`);
  return { ok: errors.length === 0, errors, totalCases: cases.length, reviewedCases: reviewed.length, minimumReviewedCases: minimum };
}

async function api(apiBase, route, options = {}) {
  const response = await fetch(`${apiBase}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status} from ${route}`);
  return payload;
}

async function waitForDeepSearch(apiBase, jobId, deadlineMs, pollMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const payload = await api(apiBase, `/deep-summary/${encodeURIComponent(jobId)}`);
    if (TERMINAL_STATUSES.has(payload.job?.status)) {
      if (payload.job.status !== 'completed') throw new Error(payload.job.error || `Deep Search ended as ${payload.job.status}`);
      return payload.job;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Deep Search ${jobId} exceeded the benchmark deadline`);
}

async function verifyEvidence(evidence) {
  if (!evidence || !evidence.length) {
    return {
      citationsChecked: 0,
      citationsPassed: 0,
      citationsFailed: 0,
      hasEvidence: false,
      exactEvidence: null,
      failures: [],
    };
  }
  const units = await database.getAnswerUnits(indexConnection, evidence.map((item) => item.sourceId));
  const byId = new Map(units.map((unit) => [String(unit.answerUnitId), unit]));
  let citationsPassed = 0;
  let citationsFailed = 0;
  const failures = [];

  for (const item of evidence) {
    const unit = byId.get(String(item.answerUnitId));
    const valid = Boolean(
      unit &&
      unit.author === 'Swami' &&
      item.start >= unit.start &&
      item.end <= unit.end &&
      unit.displayText.slice(item.start, item.end) === item.text &&
      sha256(item.text) === item.contentHash
    );
    if (valid) {
      citationsPassed += 1;
    } else {
      citationsFailed += 1;
      failures.push({
        answerUnitId: item.answerUnitId,
        author: unit?.author,
        offsetValid: Boolean(unit && item.start >= unit.start && item.end <= unit.end),
        textMatch: Boolean(unit && unit.displayText.slice(item.start, item.end) === item.text),
        hashMatch: sha256(item.text || '') === item.contentHash,
      });
    }
  }

  return {
    citationsChecked: evidence.length,
    citationsPassed,
    citationsFailed,
    hasEvidence: true,
    exactEvidence: citationsFailed === 0,
    failures,
  };
}

function scoreCase(entry, job, latencyMs) {
  const result = job.result || {};
  const review = groundTruthReviewFor(entry) || {};
  const primaryIds = new Set((review.primaryAnswerUnitIds || []).map(String));
  const acceptableIds = new Set((review.acceptableAnswerUnitIds || []).map(String));
  const forbiddenIds = new Set((review.forbiddenAnswerUnitIds || []).map(String));
  const relevantIds = new Set([...primaryIds, ...acceptableIds]);
  const candidateIds = new Set((job.metrics?.candidateFlow?.candidateAnswerUnitIds ||
    result.audit?.performance?.candidateFlow?.candidateAnswerUnitIds || []).map(String));
  const evidenceIds = new Set((result.evidence || []).map((item) => String(item.answerUnitId)));
  const candidateHits = [...primaryIds].filter((id) => candidateIds.has(id)).length;
  const evidenceHits = [...primaryIds].filter((id) => evidenceIds.has(id)).length;
  const evidenceTruePositives = [...evidenceIds].filter((id) => relevantIds.has(id)).length;
  const forbiddenEvidence = [...evidenceIds].filter((id) => forbiddenIds.has(id));
  const expectedAbstention = review.answerStatus === 'insufficient';
  return {
    id: entry.id,
    category: entry.category,
    latencyMs,
    expectedAnswerStatus: review.answerStatus,
    groundTruthReviewer: review.reviewedBy,
    actualAnswerStatus: result.answerStatus,
    answerStatusCorrect: result.answerStatus === review.answerStatus,
    candidateRecall: primaryIds.size ? candidateHits / primaryIds.size : null,
    evidenceRecall: primaryIds.size ? evidenceHits / primaryIds.size : null,
    evidencePrecision: evidenceIds.size ? evidenceTruePositives / evidenceIds.size : (expectedAbstention ? 1 : 0),
    forbiddenEvidenceRate: evidenceIds.size ? forbiddenEvidence.length / evidenceIds.size : 0,
    forbiddenEvidenceAnswerUnitIds: forbiddenEvidence,
    abstentionCorrect: expectedAbstention ? result.answerStatus === 'insufficient' : result.answerStatus !== 'insufficient',
    candidateAnswerUnitIds: [...candidateIds],
    evidenceAnswerUnitIds: [...evidenceIds],
    tokenUsage: job.metrics?.tokenUsage || result.audit?.performance?.tokenUsage || {},
    phaseTimings: job.metrics?.phases || result.audit?.performance?.phases || {},
  };
}

function summarize(results) {
  const numeric = (key) => results.map((entry) => entry[key]).filter(Number.isFinite);
  const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  const latencies = numeric('latencyMs');
  const casesWithEvidence = results.filter((r) => r.hasEvidence);
  const casesWithoutEvidence = results.filter((r) => !r.hasEvidence);
  const totalCitationsChecked = results.reduce((sum, r) => sum + (r.citationsChecked || 0), 0);
  const totalCitationsPassed = results.reduce((sum, r) => sum + (r.citationsPassed || 0), 0);
  const totalCitationsFailed = results.reduce((sum, r) => sum + (r.citationsFailed || 0), 0);
  const citationPassRate = totalCitationsChecked ? totalCitationsPassed / totalCitationsChecked : 1.0;
  const exactEvidenceRate = casesWithEvidence.length
    ? casesWithEvidence.filter((r) => r.exactEvidence === true).length / casesWithEvidence.length
    : 1.0;

  return {
    cases: results.length,
    casesWithEvidence: casesWithEvidence.length,
    casesWithoutEvidence: casesWithoutEvidence.length,
    citationsChecked: totalCitationsChecked,
    citationsPassed: totalCitationsPassed,
    citationsFailed: totalCitationsFailed,
    citationPassRate,
    exactEvidenceRate,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    candidateRecall: mean(numeric('candidateRecall')),
    evidenceRecall: mean(numeric('evidenceRecall')),
    evidencePrecision: mean(numeric('evidencePrecision')),
    forbiddenEvidenceRate: mean(numeric('forbiddenEvidenceRate')),
    answerStatusAccuracy: mean(results.map((entry) => Number(entry.answerStatusCorrect))),
    abstentionAccuracy: mean(results.map((entry) => Number(entry.abstentionCorrect))),
    promptTokens: results.reduce((total, entry) => total + (Number(entry.tokenUsage?.prompt) || 0), 0),
    completionTokens: results.reduce((total, entry) => total + (Number(entry.tokenUsage?.completion) || 0), 0),
  };
}

async function run() {
  const benchmarkPath = path.resolve(process.env.SEMANTIC_QA_DEEP_BENCHMARK || DEFAULT_BENCHMARK);
  const document = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));
  const validation = validateBenchmark(document);
  if (process.argv.includes('--validate-only')) {
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
    if (!validation.ok) process.exitCode = 1;
    return;
  }
  if (!validation.ok) throw new Error(`Deep Search benchmark is not frozen:\n- ${validation.errors.join('\n- ')}`);

  const indexStatus = await database.getIndexStatus(indexConnection);
  const expectedContract = document.corpusContract || {};
  const contractErrors = [];
  if (indexStatus.corpus?.retrievalSchemaVersion !== expectedContract.retrievalSchemaVersion) {
    contractErrors.push(`retrieval schema is ${indexStatus.corpus?.retrievalSchemaVersion || 'missing'}, expected ${expectedContract.retrievalSchemaVersion}`);
  }
  if (indexStatus.corpus?.embeddingFormatVersion !== expectedContract.embeddingFormatVersion) {
    contractErrors.push(`embedding format is ${indexStatus.corpus?.embeddingFormatVersion || 'missing'}, expected ${expectedContract.embeddingFormatVersion}`);
  }
  if (expectedContract.embeddingModel && normalizeModelReference(indexStatus.corpus?.embeddingModel) !== normalizeModelReference(expectedContract.embeddingModel)) {
    contractErrors.push(`embedding model is ${indexStatus.corpus?.embeddingModel || 'missing'}, expected ${expectedContract.embeddingModel}`);
  }
  if (contractErrors.length) throw new Error(`Evaluation index does not match the frozen benchmark contract:\n- ${contractErrors.join('\n- ')}`);

  const apiBase = String(process.env.SEMANTIC_QA_EVAL_API || DEFAULT_API_BASE).replace(/\/+$/u, '');
  const deadlineMs = Math.max(60_000, Number(process.env.SEMANTIC_QA_EVAL_DEADLINE_MS) || 90 * 60 * 1000);
  const pollMs = Math.max(250, Number(process.env.SEMANTIC_QA_EVAL_POLL_MS) || 1000);
  const targetCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) || process.env.SEMANTIC_QA_EVAL_CASE;
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))?.slice(8) || process.env.SEMANTIC_QA_EVAL_LIMIT;
  const deliberation = process.env.SEMANTIC_QA_DELIBERATION || (process.argv.find((a) => a.startsWith('--deliberation='))?.split('=')[1]) || 'maximum';
  const deepMaxRecords = Number(process.env.SEMANTIC_QA_DEEP_MAX_RECORDS) || Number(process.argv.find((a) => a.startsWith('--max-records='))?.split('=')[1]) || (deliberation === 'maximum' ? 100 : 20);
  const targetModel = process.env.SEMANTIC_QA_DEEP_MODEL || (process.argv.find((a) => a.startsWith('--model='))?.split('=')[1]) || 'qwen2.5:7b';
  const variant = process.env.SEMANTIC_QA_DEEP_VARIANT || (process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1]) || (deliberation === 'maximum' ? 'legacy-baseline' : `deliberation-${deliberation}`);

  let reviewedCases = document.cases.filter((entry) => groundTruthReviewFor(entry));
  if (targetCase) {
    reviewedCases = reviewedCases.filter((entry) => entry.id === targetCase);
  }
  if (limitArg) {
    reviewedCases = reviewedCases.slice(0, Math.max(1, Number(limitArg)));
  }
  const results = [];
  const failures = [];
  let executionError = null;

  try {
    for (const [index, entry] of reviewedCases.entries()) {
      const startedAt = Date.now();
      try {
        const search = await api(apiBase, '/search', {
          method: 'POST',
          body: JSON.stringify({
            indexConnection,
            ollamaBaseUrl: process.env.SEMANTIC_QA_EVAL_OLLAMA || 'http://127.0.0.1:11434',
            question: entry.question,
            searchMode: 'semantic',
            topK: 20,
            threshold: Number(process.env.SEMANTIC_QA_EVAL_THRESHOLD || 0.49),
            summary: {
              enabled: false,
              mode: 'deep',
              deepModel: targetModel,
              deliberation,
              deepMaxRecords,
              parallelRequests: 1,
              requestTimeoutMs: 900000,
              hardwarePreference: process.env.SEMANTIC_QA_HARDWARE || 'auto',
            },
          }),
        });
        if (!search.deepSummaryJob?.id) throw new Error(`${entry.id}: search did not start Deep Search`);
        const job = await waitForDeepSearch(apiBase, search.deepSummaryJob.id, deadlineMs, pollMs);
        const scored = scoreCase(entry, job, Date.now() - startedAt);
        const evidenceVerification = await verifyEvidence(job.result?.evidence || []);
        scored.citationsChecked = evidenceVerification.citationsChecked;
        scored.citationsPassed = evidenceVerification.citationsPassed;
        scored.citationsFailed = evidenceVerification.citationsFailed;
        scored.exactEvidence = evidenceVerification.exactEvidence;
        scored.hasEvidence = evidenceVerification.hasEvidence;
        results.push(scored);
        process.stderr.write(`Evaluated ${index + 1}/${reviewedCases.length}: ${entry.id} (${deliberation}, ${job.result?.answerStatus})\n`);
      } catch (caseErr) {
        process.stderr.write(`Failed case ${entry.id}: ${caseErr.message}\n`);
        failures.push({
          id: entry.id,
          error: caseErr.message,
          durationMs: Date.now() - startedAt,
        });
      }
    }
  } catch (err) {
    executionError = err;
  } finally {
    const totalReviewed = document.cases.filter((entry) => groundTruthReviewFor(entry)).length;
    const report = {
      executedCases: results.length,
      failedCasesCount: failures.length,
      reviewedCases: totalReviewed,
      completeBenchmarkRun: results.length === totalReviewed && failures.length === 0,
      benchmarkVersion: document.version,
      variant,
      deliberation,
      createdAt: new Date().toISOString(),
      corpusContract: document.corpusContract,
      summary: summarize(results),
      results,
      failures,
      ...(executionError ? { executionError: executionError.message } : {}),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (process.env.SEMANTIC_QA_DEEP_REPORT) {
      fs.writeFileSync(path.resolve(process.env.SEMANTIC_QA_DEEP_REPORT), `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  if (executionError || failures.length > 0 || !results.length || results.some((entry) => !entry.answerStatusCorrect || !entry.abstentionCorrect || entry.exactEvidence === false || entry.forbiddenEvidenceRate > 0 || (entry.evidenceRecall !== null && entry.evidenceRecall < 1))) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { groundTruthReviewFor, percentile, scoreCase, summarize, validateBenchmark };
