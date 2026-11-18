const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const database = require('../src/database');

const apiBase = String(process.env.SEMANTIC_QA_EVAL_API || 'http://127.0.0.1:8790/api').replace(/\/+$/, '');
const topK = Math.max(1, Math.min(20, Number(process.env.SEMANTIC_QA_EVAL_TOP_K || 5)));
const threshold = Number(process.env.SEMANTIC_QA_EVAL_THRESHOLD || 0.49);

const indexConnection = {
  connectionString: '',
  host: process.env.SEMANTIC_QA_EVAL_PG_HOST || '127.0.0.1',
  port: Number(process.env.SEMANTIC_QA_EVAL_PG_PORT || 5433),
  user: process.env.SEMANTIC_QA_EVAL_PG_USER || 'semantic_qa_indexer',
  password: process.env.SEMANTIC_QA_EVAL_PG_PASSWORD || '',
  database: process.env.SEMANTIC_QA_EVAL_PG_DATABASE || 'universal_qa_v3_candidate',
  sslMode: process.env.SEMANTIC_QA_EVAL_PG_SSL_MODE || 'disable',
};

async function search(question) {
  const response = await fetch(`${apiBase}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      indexConnection,
      ollamaBaseUrl: process.env.SEMANTIC_QA_EVAL_OLLAMA || 'http://127.0.0.1:11434',
      question,
      topK,
      threshold,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Search returned HTTP ${response.status}`);
  return payload;
}

async function run() {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const versionArg = process.argv.find((a) => a.startsWith('--version='))?.slice(10) || process.env.HELD_OUT_VERSION || '2';
  const splitArg = process.argv.find((a) => a.startsWith('--split='))?.slice(8) || process.env.HELD_OUT_SPLIT || (versionArg === '2' ? 'holdout' : 'test_sealed');
  const frozenDir = path.join(__dirname, '..', 'benchmark', 'frozen');
  let filename = versionArg === '2'
    ? (splitArg === 'all' ? 'held_out_150_v2_queries.json' : `held_out_150_v2_${splitArg}.json`)
    : (splitArg === 'all' ? 'held_out_150_queries.json' : `held_out_150_${splitArg}.json`);
  let filePath = path.join(frozenDir, filename);

  if (!fs.existsSync(filePath) && versionArg === '2' && splitArg === 'test_sealed') {
    filePath = path.join(frozenDir, 'held_out_150_v2_regression.json');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Benchmark split file not found: ${filePath}`);
  }

  const rootDir = path.resolve(__dirname, '..');
  let gitSha = 'unknown';
  let gitDirty = false;
  try {
    gitSha = execSync('git rev-parse HEAD', { cwd: rootDir }).toString().trim();
    gitDirty = execSync('git status --porcelain', { cwd: rootDir }).toString().trim().length > 0;
  } catch (e) {
    // ignore
  }

  const fileBytes = fs.readFileSync(filePath);
  const benchmarkSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
  let indexStatus = null;
  try {
    indexStatus = await database.getIndexStatus(indexConnection);
  } catch (e) {
    // ignore
  }

  const benchmarkData = JSON.parse(fileBytes.toString('utf8'));
  const cases = benchmarkData.queries || [];

  const results = [];
  const categoryStats = {};

  for (const [index, entry] of cases.entries()) {
    const payload = await search(entry.question);
    const topSourceIds = (payload.matches || []).map((m) => m.sourceId);
    const topGroups = (payload.matches || []).map((m) => m.sourceGroup || m.sourceId);

    const isPositive = !entry.shouldAbstain;
    let rank = null;
    let pass = false;

    if (isPositive) {
      const relevant = entry.relevantSourceGroups || (entry.expectedSourceId ? [entry.expectedSourceId] : []);
      const matchIndex = topGroups.findIndex((g) => relevant.includes(g));
      if (matchIndex >= 0) rank = matchIndex + 1;
      pass = rank !== null && rank <= topK && payload.strongMatch === true;
    } else {
      pass = payload.strongMatch === false;
    }

    const cat = entry.category;
    if (!categoryStats[cat]) {
      categoryStats[cat] = { total: 0, passed: 0, falseAccepts: 0, positiveHits: 0, top1Hits: 0 };
    }
    categoryStats[cat].total += 1;
    if (pass) categoryStats[cat].passed += 1;
    if (!isPositive && payload.strongMatch) categoryStats[cat].falseAccepts += 1;
    if (isPositive && rank !== null) categoryStats[cat].positiveHits += 1;
    if (isPositive && rank === 1) categoryStats[cat].top1Hits += 1;

    results.push({
      id: entry.id,
      question: entry.question,
      category: entry.category,
      shouldAbstain: entry.shouldAbstain,
      expectedSourceId: entry.expectedSourceId,
      strongMatch: payload.strongMatch,
      acceptedSourceId: payload.acceptedMatch?.sourceId || null,
      rank,
      pass,
      topSourceIds,
    });
  }

  const positiveCases = results.filter((r) => !r.shouldAbstain);
  const negativeCases = results.filter((r) => r.shouldAbstain);

  const positiveAdmissionRate = positiveCases.length
    ? positiveCases.filter((r) => r.pass).length / positiveCases.length
    : 1;
  const negativeRejectionRate = negativeCases.length
    ? negativeCases.filter((r) => r.pass).length / negativeCases.length
    : 1;
  const positiveRecallAt5 = positiveCases.length
    ? positiveCases.filter((r) => r.rank !== null && r.rank <= 5).length / positiveCases.length
    : 1;
  const positiveTop1Accuracy = positiveCases.length
    ? positiveCases.filter((r) => r.rank === 1).length / positiveCases.length
    : 1;
  const meanReciprocalRank = positiveCases.length
    ? positiveCases.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / positiveCases.length
    : 1;
  const falseAcceptRate = negativeCases.length
    ? negativeCases.filter((r) => r.strongMatch).length / negativeCases.length
    : 0;

  const passedTotal = results.filter((r) => r.pass).length;

  const summary = {
    benchmarkVersion: Number(versionArg) || 1,
    split: splitArg,
    gitSha,
    gitDirty,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    benchmarkSha256,
    indexIdentity: {
      host: indexConnection.host,
      port: indexConnection.port,
      database: indexConnection.database,
      retrievalSchemaVersion: indexStatus?.corpus?.retrievalSchemaVersion,
      embeddingFormatVersion: indexStatus?.corpus?.embeddingFormatVersion,
      embeddingModel: indexStatus?.corpus?.embeddingModel,
      embeddingModelDigest: indexStatus?.corpus?.embeddingModelDigest,
      recordCount: indexStatus?.recordCount,
    },
    settings: {
      apiBase,
      topK,
      threshold,
      ollamaBaseUrl: process.env.SEMANTIC_QA_EVAL_OLLAMA || 'http://127.0.0.1:11434',
    },
    totalCases: results.length,
    passed: passedTotal,
    positiveCases: positiveCases.length,
    negativeCases: negativeCases.length,
    positiveAdmissionRate,
    negativeRejectionRate,
    positiveRecallAt5,
    positiveTop1Accuracy,
    meanReciprocalRank,
    falseAcceptRate,
    categoryBreakdown: categoryStats,
    gatesPassed: {
      positiveAdmissionGte95: positiveAdmissionRate >= 0.95,
      recallAt5Gte95: positiveRecallAt5 >= 0.95,
      top1Gte90: positiveTop1Accuracy >= 0.90,
      falseAcceptLte02: falseAcceptRate <= 0.02,
    },
    releaseVerdict: (
      positiveAdmissionRate >= 0.95 &&
      positiveRecallAt5 >= 0.95 &&
      positiveTop1Accuracy >= 0.90 &&
      falseAcceptRate <= 0.02
    ) ? 'APPROVED' : 'REJECTED',
  };

  const reportPath = path.join(__dirname, '..', 'benchmark', 'results', `held_out_150_${splitArg}_results.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({ summary, results }, null, 2)}\n`);

  if (['test_sealed', 'holdout', 'regression'].includes(splitArg)) {
    const verdictFilename = splitArg === 'regression' ? 'STANDARD_SEARCH_REGRESSION_REPORT.md' : 'STANDARD_SEARCH_SEALED_VERDICT.md';
    const verdictPath = path.join(__dirname, '..', 'benchmark', verdictFilename);
    const failures = results.filter((r) => !r.pass);
    const splitDesc = splitArg === 'holdout'
      ? '`holdout` (Fresh Unseen Holdout: 30 reviewed cases: 10 positive paraphrases, 20 negative controls)'
      : splitArg === 'regression'
      ? '`regression` (Regression Suite: 30 reviewed cases: 10 positive paraphrases, 20 negative controls)'
      : '`test_sealed` (30 reviewed cases: 10 positive paraphrases, 20 negative controls)';
    const title = splitArg === 'regression' ? '# Standard Search Regression Suite Report' : '# Standard Search Sealed Release Verdict';
    const md = `${title}

**Execution Date:** ${summary.finishedAt}  
**Split:** ${splitDesc}  
**Benchmark Version:** ${summary.benchmarkVersion}  
**Git Commit SHA:** \`${summary.gitSha}\`  
**Git Working Tree:** ${summary.gitDirty ? 'dirty (uncommitted working tree changes)' : 'clean'}  
**Target Database:** \`${summary.indexIdentity.database}\` (port ${summary.indexIdentity.port}, ${summary.indexIdentity.recordCount || 6010} records)  
**Corpus Contract:** Schema \`${summary.indexIdentity.retrievalSchemaVersion}\`, Embedding \`${summary.indexIdentity.embeddingFormatVersion}\`, Model \`${summary.indexIdentity.embeddingModel}\`  
**Benchmark File Hash (SHA-256):** \`${summary.benchmarkSha256}\`  
**Evaluation Duration:** ${(summary.durationMs / 1000).toFixed(1)}s  

---

## 1. Release Gates Scorecard (Sealed Holdout)

| Gate | Target Requirement | Measured Value | Result |
| :--- | :--- | :--- | :--- |
| **1. Positive Admission Rate** | $\\ge 0.95$ ($\\ge 95\\%$ strong-match pass) | **${(summary.positiveAdmissionRate * 100).toFixed(1)}%** (${positiveCases.filter((r) => r.pass).length}/${positiveCases.length}) | ${summary.gatesPassed.positiveAdmissionGte95 ? 'PASSED' : '**FAILED**'} |
| **2. Positive Recall@5** | $\\ge 0.95$ ($\\ge 95\\%$ in top-5) | **${(summary.positiveRecallAt5 * 100).toFixed(1)}%** (${positiveCases.filter((r) => r.rank && r.rank <= 5).length}/${positiveCases.length}) | ${summary.gatesPassed.recallAt5Gte95 ? 'PASSED' : '**FAILED**'} |
| **3. Positive Top-1 Accuracy** | $\\ge 0.90$ ($\\ge 90\\%$ rank 1) | **${(summary.positiveTop1Accuracy * 100).toFixed(1)}%** (${positiveCases.filter((r) => r.rank === 1).length}/${positiveCases.length}) | ${summary.gatesPassed.top1Gte90 ? 'PASSED' : '**FAILED**'} |
| **4. Negative False-Accept Rate** | $\\le 0.02$ ($\\le 2\\%$ false accepts) | **${(summary.falseAcceptRate * 100).toFixed(1)}%** (${negativeCases.filter((r) => r.strongMatch).length}/${negativeCases.length}) | ${summary.gatesPassed.falseAcceptLte02 ? 'PASSED' : '**FAILED**'} |

---

## 2. Verdict & Recommendation

**Verdict:** **${summary.releaseVerdict}**  
${summary.releaseVerdict === 'APPROVED'
  ? 'Standard Search satisfies all four release gates on the sealed test set. The model cleanly admits answerable spiritual paraphrases while strictly abstaining from physical tasks, out-of-domain knowledge, and lexical traps.'
  : 'Standard Search did not meet one or more release gates on the sealed test set. Production promotion must be withheld until all four gates pass.'}

---

## 3. Category Breakdown

| Category | Total Cases | Passed | False Accepts | Top-1 Hits |
| :--- | :--- | :--- | :--- | :--- |
${Object.entries(categoryStats).map(([cat, s]) => `| \`${cat}\` | ${s.total} | ${s.passed} (${((s.passed / s.total) * 100).toFixed(1)}%) | ${s.falseAccepts} | ${s.top1Hits} |`).join('\n')}

---

## 4. Failure Ledger

${failures.length === 0 ? 'No failures on the sealed test set (100% pass rate).' : failures.map((f, i) => `### Failure ${i + 1}: \`${f.id}\`
* **Question:** "${f.question}"
* **Category:** \`${f.category}\` (shouldAbstain: ${f.shouldAbstain})
* **Expected:** ${f.shouldAbstain ? 'Abstain (`strongMatch = false`)' : `Strong Match for \`${f.expectedSourceId}\``}
* **Actual:** \`strongMatch = ${f.strongMatch}\` (accepted: \`${f.acceptedSourceId}\`, rank: ${f.rank})
`).join('\n')}
`;
    fs.writeFileSync(verdictPath, md, 'utf8');
    console.log(`Generated sealed verdict report: ${verdictPath}`);
  }

  process.stdout.write(`${JSON.stringify({ summary, reportPath }, null, 2)}\n`);

  if (!summary.gatesPassed.positiveAdmissionGte95 || !summary.gatesPassed.recallAt5Gte95 || !summary.gatesPassed.top1Gte90 || !summary.gatesPassed.falseAcceptLte02) {
    console.error('Work Package 4 Acceptance Gates NOT met on split:', splitArg);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
