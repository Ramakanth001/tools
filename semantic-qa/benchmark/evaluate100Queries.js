/**
 * Automated 100-Query Benchmark Suite for Distance-Based Search Engine
 * Measures Retrieval Precision, Mean Reciprocal Rank (MRR), and Latency Distributions
 * across 100 Diverse Theological Queries on the Live Corpus (6,010 records).
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { searchDistanceCorpus, clearIdfCache } = require('../src/distanceSearch');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5433,
  user: 'postgres',
  database: 'universal_qa_v2',
  max: 10,
});

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function run100Benchmark() {
  const jsonPath = path.join(__dirname, '100_evaluation_queries.json');
  if (!fs.existsSync(jsonPath)) {
    console.error('Queries file not found at:', jsonPath);
    process.exit(1);
  }

  const rawQueries = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const queries = rawQueries.map(q => ({
    ...q,
    expectedPattern: new RegExp(q.expectedPattern, 'i'),
  }));

  console.log('='.repeat(85));
  console.log('DISTANCE-BASED SEARCH ENGINE: 100-QUERY COMPREHENSIVE RETRIEVAL BENCHMARK');
  console.log('Corpus: universal_qa_v2 (6,010 discourses) | PostgreSQL GIN + Tiered Ranker');
  console.log(`Evaluating ${queries.length} unique queries across 10 theological domains`);
  console.log('='.repeat(85));

  // Warm-up query
  await searchDistanceCorpus(pool, { query: 'test warm up', limit: 5 });

  const queryResults = [];
  const latencies = [];
  let reciprocalRankSum = 0;
  let top1HitCount = 0;
  let top5HitCount = 0;
  let top10HitCount = 0;
  let top35HitCount = 0;

  const domainStats = {};

  for (let i = 0; i < queries.length; i++) {
    const qObj = queries[i];
    if (!domainStats[qObj.domain]) {
      domainStats[qObj.domain] = { total: 0, top1: 0, top5: 0, top10: 0, latencies: [] };
    }
    const dStat = domainStats[qObj.domain];
    dStat.total++;

    const t0 = performance.now();
    const result = await searchDistanceCorpus(pool, { query: qObj.query, limit: 35 });
    const t1 = performance.now();
    const elapsedMs = t1 - t0;
    latencies.push(elapsedMs);
    dStat.latencies.push(elapsedMs);

    const matches = result.matches || [];
    let rankFirstHit = 0;

    for (let r = 0; r < matches.length; r++) {
      const m = matches[r];
      if (qObj.expectedPattern.test(m.title)) {
        rankFirstHit = r + 1;
        break;
      }
    }

    const isTop1 = rankFirstHit === 1;
    const isTop5 = rankFirstHit >= 1 && rankFirstHit <= 5;
    const isTop10 = rankFirstHit >= 1 && rankFirstHit <= 10;
    const isTop35 = rankFirstHit >= 1;

    if (isTop1) { top1HitCount++; dStat.top1++; }
    if (isTop5) { top5HitCount++; dStat.top5++; }
    if (isTop10) { top10HitCount++; dStat.top10++; }
    if (isTop35) { top35HitCount++; }

    const reciprocalRank = rankFirstHit > 0 ? (1 / rankFirstHit) : 0;
    reciprocalRankSum += reciprocalRank;

    const topTitle = matches.length > 0 ? matches[0].title : 'NO RESULTS';
    const topScore = matches.length > 0 ? matches[0].score : 0;
    const topSourceId = matches.length > 0 ? matches[0].sourceId : 'none';

    queryResults.push({
      id: qObj.id,
      domain: qObj.domain,
      query: qObj.query,
      topTitle,
      topScore,
      topSourceId,
      rankFirstHit: rankFirstHit || 'N/A',
      elapsedMs,
      status: isTop1 ? 'PASS (Top 1)' : (isTop5 ? 'PASS (Top 5)' : (isTop10 ? 'HIT (Top 10)' : (isTop35 ? 'HIT (Top 35)' : 'MISS'))),
    });

    console.log(`[Q${String(qObj.id).padStart(3, '0')}] "${qObj.query}"`);
    console.log(`      Top #1: ${topTitle} [${topSourceId}] (Score: ${topScore})`);
    console.log(`      Target Hit Rank: #${rankFirstHit || 'N/A'} | Latency: ${elapsedMs.toFixed(1)} ms | Status: ${queryResults[queryResults.length - 1].status}`);
  }

  const totalQueries = queries.length;
  const mrr = reciprocalRankSum / totalQueries;
  const top1Accuracy = (top1HitCount / totalQueries) * 100;
  const top5Accuracy = (top5HitCount / totalQueries) * 100;
  const top10Accuracy = (top10HitCount / totalQueries) * 100;
  const top35Accuracy = (top35HitCount / totalQueries) * 100;

  const p50 = percentile(latencies, 50);
  const p75 = percentile(latencies, 75);
  const p90 = percentile(latencies, 90);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  console.log('\n' + '='.repeat(85));
  console.log('100-QUERY BENCHMARK EVALUATION SUMMARY REPORT');
  console.log('='.repeat(85));
  console.log(`Total Queries Evaluated:                ${totalQueries}`);
  console.log(`Mean Reciprocal Rank (MRR):             ${mrr.toFixed(3)}  (Target: > 0.850)`);
  console.log(`Top-1 Target Retrieval Accuracy:        ${top1Accuracy.toFixed(1)}% (${top1HitCount}/${totalQueries})`);
  console.log(`Top-5 Target Retrieval Rate:            ${top5Accuracy.toFixed(1)}% (${top5HitCount}/${totalQueries})`);
  console.log(`Top-10 Target Retrieval Rate:           ${top10Accuracy.toFixed(1)}% (${top10HitCount}/${totalQueries})`);
  console.log(`Top-35 Overall Recall Rate:             ${top35Accuracy.toFixed(1)}% (${top35HitCount}/${totalQueries})`);
  console.log('-'.repeat(85));
  console.log('LATENCY PERCENTILE DISTRIBUTION:');
  console.log(`  * Minimum Latency:                    ${minLatency.toFixed(1)} ms`);
  console.log(`  * p50 (Median Latency):               ${p50.toFixed(1)} ms`);
  console.log(`  * p75 Latency:                        ${p75.toFixed(1)} ms`);
  console.log(`  * p90 Latency:                        ${p90.toFixed(1)} ms`);
  console.log(`  * p95 Latency:                        ${p95.toFixed(1)} ms`);
  console.log(`  * p99 Latency:                        ${p99.toFixed(1)} ms`);
  console.log(`  * Maximum Latency:                    ${maxLatency.toFixed(1)} ms`);
  console.log(`  * Mean Average Latency:               ${avgLatency.toFixed(1)} ms`);
  console.log('-'.repeat(85));

  console.log('BREAKDOWN BY THEOLOGICAL DOMAIN:');
  for (const [domain, stat] of Object.entries(domainStats)) {
    const dTop1 = ((stat.top1 / stat.total) * 100).toFixed(1);
    const dTop5 = ((stat.top5 / stat.total) * 100).toFixed(1);
    const dP50 = percentile(stat.latencies, 50).toFixed(1);
    console.log(`  * ${domain.padEnd(32)} | Top-1: ${dTop1}% | Top-5: ${dTop5}% | p50: ${dP50} ms`);
  }
  console.log('='.repeat(85));

  // Generate Markdown report
  let mdReport = `# 100-Query Distance-Based Search Evaluation Benchmark Report\n\n`;
  mdReport += `> **Corpus:** \`universal_qa_v2\` (6,010 discourses | ~45M characters)  \n`;
  mdReport += `> **Engine:** PostgreSQL 16 GIN Candidate Retrieval + Distance Rescoring  \n`;
  mdReport += `> **Evaluation Scope:** 100 diverse, natural spiritual inquiries across 10 theological domains  \n`;
  mdReport += `> **Date:** ${new Date().toISOString()}  \n\n`;

  mdReport += `## 1. Executive Summary Metrics\n\n`;
  mdReport += `| Metric | Result | Target / Standard |\n`;
  mdReport += `| :--- | :--- | :--- |\n`;
  mdReport += `| **Mean Reciprocal Rank (MRR)** | **\`${mrr.toFixed(3)}\`** | &gt; 0.850 |\n`;
  mdReport += `| **Top-1 Target Retrieval Accuracy** | **\`${top1Accuracy.toFixed(1)}%\`** (${top1HitCount}/${totalQueries}) | &gt; 80.0% |\n`;
  mdReport += `| **Top-5 Target Retrieval Rate** | **\`${top5Accuracy.toFixed(1)}%\`** (${top5HitCount}/${totalQueries}) | &gt; 90.0% |\n`;
  mdReport += `| **Top-10 Target Retrieval Rate** | **\`${top10Accuracy.toFixed(1)}%\`** (${top10HitCount}/${totalQueries}) | &gt; 95.0% |\n`;
  mdReport += `| **Top-35 Overall Corpus Recall** | **\`${top35Accuracy.toFixed(1)}%\`** (${top35HitCount}/${totalQueries}) | &gt; 95.0% |\n\n`;

  mdReport += `## 2. Latency Distribution across 100 Queries\n\n`;
  mdReport += `| Percentile | Latency (ms) |\n`;
  mdReport += `| :--- | :--- |\n`;
  mdReport += `| **Minimum** | \`${minLatency.toFixed(1)} ms\` |\n`;
  mdReport += `| **p50 (Median)** | \`${p50.toFixed(1)} ms\` |\n`;
  mdReport += `| **p75** | \`${p75.toFixed(1)} ms\` |\n`;
  mdReport += `| **p90** | \`${p90.toFixed(1)} ms\` |\n`;
  mdReport += `| **p95** | \`${p95.toFixed(1)} ms\` |\n`;
  mdReport += `| **p99** | \`${p99.toFixed(1)} ms\` |\n`;
  mdReport += `| **Maximum** | \`${maxLatency.toFixed(1)} ms\` |\n`;
  mdReport += `| **Mean Average** | \`${avgLatency.toFixed(1)} ms\` |\n\n`;

  mdReport += `## 3. Breakdown by Theological Domain\n\n`;
  mdReport += `| Domain | Queries | Top-1 Accuracy | Top-5 Rate | Median Latency (p50) |\n`;
  mdReport += `| :--- | :---: | :---: | :---: | :---: |\n`;
  for (const [domain, stat] of Object.entries(domainStats)) {
    const dTop1 = ((stat.top1 / stat.total) * 100).toFixed(1);
    const dTop5 = ((stat.top5 / stat.total) * 100).toFixed(1);
    const dP50 = percentile(stat.latencies, 50).toFixed(1);
    mdReport += `| **${domain}** | ${stat.total} | ${dTop1}% | ${dTop5}% | ${dP50} ms |\n`;
  }

  mdReport += `\n## 4. Full Query-by-Query Retrieval Log\n\n`;
  mdReport += `| # | Domain | Query | Top #1 Retrieved Discourse | Target Hit Rank | Latency | Status |\n`;
  mdReport += `| :-: | :--- | :--- | :--- | :-: | :-: | :-: |\n`;
  for (const r of queryResults) {
    const cleanTitle = r.topTitle.replace(/\|/g, '-');
    mdReport += `| **Q${String(r.id).padStart(3, '0')}** | ${r.domain} | \`${r.query}\` | ${cleanTitle} | **#${r.rankFirstHit}** | ${r.elapsedMs.toFixed(1)} ms | ${r.status.startsWith('PASS') ? '✅ ' + r.status : '⚠️ ' + r.status} |\n`;
  }

  const reportPath = path.join(__dirname, '100_queries_evaluation_report.md');
  fs.writeFileSync(reportPath, mdReport, 'utf8');
  console.log('\nWrote full Markdown benchmark report to:', reportPath);

  await pool.end();
}

run100Benchmark().catch(console.error);
