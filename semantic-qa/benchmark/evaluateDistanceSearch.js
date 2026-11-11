/**
 * Automated Evaluation Benchmark Suite for Distance-Based Search Engine
 * Measures Retrieval Precision, Mean Reciprocal Rank (MRR), and Latency Distributions
 * across Diverse Theological Queries on the Live Corpus (6,010 records).
 */

const { Pool } = require('pg');
const { searchDistanceCorpus, clearIdfCache } = require('../src/distanceSearch');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5433,
  user: 'postgres',
  database: 'universal_qa_v2',
  max: 10,
});

const EVAL_QUERIES = [
  {
    query: 'what is the real meaning of Gayatri mantra?',
    primaryTopic: 'gayatri',
    expectedTopTitlePattern: /gayatri|gayathri/i,
    description: 'Foundational definition query on Gayatri'
  },
  {
    query: 'Gāyatrī mantra',
    primaryTopic: 'gayatri',
    expectedTopTitlePattern: /gayatri|gayathri/i,
    description: 'IAST diacritic variant query'
  },
  {
    query: 'what is the real meaning of Upanayanam?',
    primaryTopic: 'upanayanam',
    expectedTopTitlePattern: /upanayana/i,
    description: 'Thread ceremony ritual significance'
  },
  {
    query: 'significance of three strings in holy cross belt in Upanayanam',
    primaryTopic: 'upanayanam',
    expectedTopTitlePattern: /three strings|cross belt|upanayanam/i,
    description: 'Specific ritual component intent'
  },
  {
    query: 'Adiparaashakti relationship with Savita devatha',
    primaryTopic: 'adiparashakti',
    expectedTopTitlePattern: /adipara|savita/i,
    description: 'Divine Mother theological inquiry'
  },
  {
    query: 'difference between pravritti and nivritti',
    primaryTopic: 'pravritti',
    expectedTopTitlePattern: /pravr[iu]tti|nivr[iu]tti/i,
    description: 'Dual theological path comparison'
  },
  {
    query: 'true interpretation of Shankara Advaita philosophy',
    primaryTopic: 'shankara',
    expectedTopTitlePattern: /shankara|sankara|advaita/i,
    description: 'Philosophical monism discourse'
  },
  {
    query: 'what is the real meaning of Sandhyavandanam?',
    primaryTopic: 'sandhyavandanam',
    expectedTopTitlePattern: /sandhya.*vandan|sandhyavandan/i,
    description: 'Daily worship practice'
  },
  {
    query: 'what is the highest form of Bhakti?',
    primaryTopic: 'bhakti',
    expectedTopTitlePattern: /bhakti|devotion/i,
    description: 'Devotional classification query'
  },
  {
    query: 'sacrifice of fruit of work karma phala tyaga',
    primaryTopic: 'karma',
    expectedTopTitlePattern: /karma|work|fruit/i,
    description: 'Core Bhagavad Gita spiritual practice'
  }
];

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runBenchmark() {
  console.log('='.repeat(75));
  console.log('DISTANCE-BASED SEARCH ENGINE: AUTOMATED EVALUATION BENCHMARK');
  console.log('Corpus: universal_qa_v2 (6,010 documents) | PostgreSQL GIN + Tiered Ranker');
  console.log('Protocol: 1 Cold Pass + 2 Warm Passes per query to isolate distributions');
  console.log('='.repeat(75));

  // 1. Cold Pass: Cache is explicitly cleared before EACH cold query
  const coldLatencies = [];
  let reciprocalRankSum = 0;
  let top1HitCount = 0;
  let targetMatchAt5Sum = 0;
  let targetMatchAt10Sum = 0;
  const totalQueries = EVAL_QUERIES.length;

  console.log('\n--- PASS 1: COLD EVALUATION & TARGET RANKING (Per-Query Cache Purge) ---');
  for (let i = 0; i < totalQueries; i++) {
    clearIdfCache();
    const qObj = EVAL_QUERIES[i];
    const t0 = performance.now();
    const result = await searchDistanceCorpus(pool, { query: qObj.query, limit: 35 });
    const t1 = performance.now();
    const elapsedMs = t1 - t0;
    coldLatencies.push(elapsedMs);

    const matches = result.matches || [];
    let rankFirstHit = 0;
    let hitsInTop5 = 0;
    let hitsInTop10 = 0;

    for (let r = 0; r < matches.length; r++) {
      const m = matches[r];
      const titleMatches = qObj.expectedTopTitlePattern.test(m.title);
      if (titleMatches && rankFirstHit === 0) {
        rankFirstHit = r + 1;
      }
      if (r < 5 && titleMatches) hitsInTop5++;
      if (r < 10 && titleMatches) hitsInTop10++;
    }

    if (rankFirstHit === 1) top1HitCount++;
    const reciprocalRank = rankFirstHit > 0 ? (1 / rankFirstHit) : 0;
    reciprocalRankSum += reciprocalRank;
    targetMatchAt5Sum += (hitsInTop5 / 5);
    targetMatchAt10Sum += (hitsInTop10 / 10);

    const topTitle = matches.length > 0 ? matches[0].title : 'NO RESULTS';
    const topScore = matches.length > 0 ? matches[0].score : 0;
    const isSuccess = rankFirstHit === 1;

    console.log(`[Q${i + 1}] "${qObj.query}"`);
    console.log(`     Top #1: ${topTitle} (Score: ${topScore})`);
    console.log(`     Target Hit Rank: #${rankFirstHit || 'N/A'} | Cold Latency: ${elapsedMs.toFixed(1)} ms | Status: ${isSuccess ? 'PASS' : 'WARN'}`);
  }

  // 2. Warm Passes: Repeated executions with cached IDF and PostgreSQL buffer cache
  console.log('\n--- PASSES 2 & 3: WARM LATENCY SAMPLING (20 iterations) ---');
  const warmLatencies = [];
  for (let pass = 2; pass <= 3; pass++) {
    for (let i = 0; i < totalQueries; i++) {
      const qObj = EVAL_QUERIES[i];
      const t0 = performance.now();
      await searchDistanceCorpus(pool, { query: qObj.query, limit: 35 });
      const t1 = performance.now();
      warmLatencies.push(t1 - t0);
    }
  }

  const mrr = reciprocalRankSum / totalQueries;
  const top1Accuracy = (top1HitCount / totalQueries) * 100;
  const avgTargetMatchAt5 = (targetMatchAt5Sum / totalQueries) * 100;
  const avgTargetMatchAt10 = (targetMatchAt10Sum / totalQueries) * 100;

  const coldP50 = percentile(coldLatencies, 50);
  const coldP95 = percentile(coldLatencies, 95);
  const warmP50 = percentile(warmLatencies, 50);
  const warmP95 = percentile(warmLatencies, 95);

  console.log('\n' + '='.repeat(75));
  console.log('SUMMARY EVALUATION METRICS (Automated Regression Suite on 10 High-Value Queries):');
  console.log('  [Note: Evaluates curated title-pattern target matches; not multi-annotator human relevance]');
  console.log(`  * Mean Reciprocal Rank (MRR):                 ${mrr.toFixed(3)}  (Target: > 0.850)`);
  console.log(`  * Top-1 Title-Pattern Target Match:          ${top1Accuracy.toFixed(1)}% (${top1HitCount}/${totalQueries} queries ranked #1)`);
  console.log(`  * Title-Pattern Target Match @ 5:            ${avgTargetMatchAt5.toFixed(1)}%`);
  console.log(`  * Title-Pattern Target Match @ 10:           ${avgTargetMatchAt10.toFixed(1)}%`);
  console.log('---');
  console.log('LATENCY DISTRIBUTIONS (Repeatable Multi-Pass Protocol):');
  console.log(`  * Cold Query Latency (Per-query cache purge): p50 = ${coldP50.toFixed(1)} ms | p95 = ${coldP95.toFixed(1)} ms  (10 cold samples)`);
  console.log(`  * Warm Query Latency (Cached IDF buffer pool): p50 = ${warmP50.toFixed(1)} ms | p95 = ${warmP95.toFixed(1)} ms  (20 warm samples)`);
  console.log('='.repeat(75));

  await pool.end();
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
