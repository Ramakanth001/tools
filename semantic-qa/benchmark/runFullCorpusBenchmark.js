const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');
const { normalizeSpiritualText } = require('E:/Universal-Spirituality/tools/semantic-qa/benchmark/spiritualNormalizer');

const OLLAMA_URL = 'http://127.0.0.1:11434';

async function getBgeEmbedding(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'bge-m3', input: text, truncate: false }),
  });
  const data = await res.json();
  return data.embeddings[0];
}

function toVectorLiteral(arr) {
  return `[${arr.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

// 1. Full-corpus Dense-Only Search on universal_qa_v2
async function searchDenseFull(client, queryVector, topK = 10) {
  const t0 = Date.now();
  const res = await client.query(`
    WITH ranked AS (
      SELECT p.source_id, p.passage_index,
             1 - (p.embedding <=> $1::vector) as similarity,
             p.title, p.passage_text,
             ROW_NUMBER() OVER (PARTITION BY p.source_id ORDER BY p.embedding <=> $1::vector) as rn
      FROM semantic_qa.passages p
      ORDER BY p.embedding <=> $1::vector
      LIMIT 120
    )
    SELECT source_id, similarity, title, passage_text as best_passage
    FROM ranked
    WHERE rn = 1
    ORDER BY similarity DESC
    LIMIT $2;
  `, [toVectorLiteral(queryVector), topK]);
  const latency = Date.now() - t0;
  return { rows: res.rows, latency };
}

// 2. Full-corpus Calibrated Hybrid Search on universal_qa_v2
async function searchHybridFull(client, queryVector, rawQuery, normalizedQuery, topK = 10) {
  const t0 = Date.now();
  const res = await client.query(`
    WITH dense_candidates AS (
      SELECT p.source_id, p.passage_index,
             1 - (p.embedding <=> $1::vector) as sim_dense,
             p.passage_text, p.title
      FROM semantic_qa.passages p
      ORDER BY p.embedding <=> $1::vector
      LIMIT 120
    ),
    lexical_scored AS (
      SELECT d.source_id, d.passage_index, d.sim_dense, d.passage_text, d.title,
             ts_rank_cd(
               setweight(to_tsvector('english', d.title), 'A') ||
               setweight(to_tsvector('english', d.passage_text), 'B'),
               plainto_tsquery('english', $2)
             ) as score_lexical,
             GREATEST(
               similarity(d.title, $3),
               similarity(substring(d.passage_text from 1 for 250), $3)
             ) as score_trgm
      FROM dense_candidates d
    ),
    combined AS (
      SELECT source_id, title, passage_text,
             sim_dense + (0.15 * LEAST(1.0, score_lexical * 2.0)) + (0.05 * score_trgm) as calibrated_score,
             sim_dense, score_lexical, score_trgm,
             ROW_NUMBER() OVER (
               PARTITION BY source_id
               ORDER BY (sim_dense + 0.15 * LEAST(1.0, score_lexical * 2.0) + 0.05 * score_trgm) DESC
             ) as rn
      FROM lexical_scored
    )
    SELECT source_id, calibrated_score as similarity, sim_dense, score_lexical, score_trgm, title, passage_text as best_passage
    FROM combined
    WHERE rn = 1
    ORDER BY calibrated_score DESC
    LIMIT $4;
  `, [toVectorLiteral(queryVector), normalizedQuery, rawQuery, topK]);
  const latency = Date.now() - t0;
  return { rows: res.rows, latency };
}

function computeIRMetrics(retrievedRows, targetIds) {
  if (!targetIds || !targetIds.length) {
    return { hit1: 0, hit5: 0, hit10: 0, rr: 0, p5: 0, ndcg10: 0, rank: null, targetCount: 0, retrievedCount: 0 };
  }

  const retrievedIds = retrievedRows.map(r => r.source_id);
  let firstRank = null;
  let p5Hits = 0;
  let dcg10 = 0;

  for (let i = 0; i < Math.min(10, retrievedIds.length); i++) {
    const isRel = targetIds.includes(retrievedIds[i]);
    if (isRel) {
      if (firstRank === null) firstRank = i + 1;
      if (i < 5) p5Hits += 1;
      dcg10 += 1 / Math.log2(i + 2);
    }
  }

  const maxPossibleRel = Math.min(10, targetIds.length);
  let idcg10 = 0;
  for (let i = 0; i < maxPossibleRel; i++) {
    idcg10 += 1 / Math.log2(i + 2);
  }
  const ndcg10 = idcg10 > 0 ? dcg10 / idcg10 : 0;

  return {
    rank: firstRank,
    hit1: firstRank === 1 ? 1 : 0,
    hit5: firstRank !== null && firstRank <= 5 ? 1 : 0,
    hit10: firstRank !== null && firstRank <= 10 ? 1 : 0,
    rr: firstRank !== null && firstRank <= 10 ? 1 / firstRank : 0,
    p5: p5Hits / 5,
    ndcg10,
    targetCount: targetIds.length,
    retrievedCount: p5Hits
  };
}

async function runBenchmark() {
  const client = new Client({
    host: '127.0.0.1',
    port: 5433,
    user: 'postgres',
    database: 'universal_qa_v2'
  });
  await client.connect();

  const testCases = require('./expandedTestCases.json');
  console.log('=== FULL-CORPUS (6,010 DISCOURSES) BENCHMARK REPORT ===');
  console.log(`Database: universal_qa_v2 (PostgreSQL 18)`);
  console.log(`Total test queries: ${testCases.length}`);

  const positiveCases = testCases.filter(c => !c.isNegative);
  const negativeCases = testCases.filter(c => c.isNegative);
  console.log(`Positive test queries: ${positiveCases.length}`);
  console.log(`Negative control queries: ${negativeCases.length}\n`);

  const configs = [
    { name: 'Full-Corpus BGE-M3 Dense-Only (1024d)', fn: (v, q, nq) => searchDenseFull(client, v, 10) },
    { name: 'Full-Corpus Calibrated Hybrid (BGE-M3 + FTS + Trigram)', fn: (v, q, nq) => searchHybridFull(client, v, q, nq, 10) }
  ];

  const results = {};
  for (const c of configs) {
    results[c.name] = {
      ranks: [],
      hit1Count: 0,
      hit5Count: 0,
      hit10Count: 0,
      totalRR: 0,
      totalP5: 0,
      totalNDCG: 0,
      latencies: [],
      negativeScores: [],
      queryDetails: [],
      failures: []
    };
  }

  let progress = 0;
  for (const tc of testCases) {
    progress++;
    if (progress % 20 === 0 || progress === testCases.length) {
      console.log(`Evaluated ${progress}/${testCases.length} queries...`);
    }

    const normQuery = normalizeSpiritualText(tc.query);
    const vec = await getBgeEmbedding(normQuery);

    for (const config of configs) {
      const searchRes = await config.fn(vec, tc.query, normQuery);
      results[config.name].latencies.push(searchRes.latency);

      if (tc.isNegative) {
        const topScore = Number(searchRes.rows[0]?.similarity ?? 0);
        results[config.name].negativeScores.push({ id: tc.id, query: tc.query, score: topScore });
      } else {
        const metrics = computeIRMetrics(searchRes.rows, tc.targets);
        results[config.name].ranks.push(metrics.rank);
        results[config.name].hit1Count += metrics.hit1;
        results[config.name].hit5Count += metrics.hit5;
        results[config.name].hit10Count += metrics.hit10;
        results[config.name].totalRR += metrics.rr;
        results[config.name].totalP5 += metrics.p5;
        results[config.name].totalNDCG += metrics.ndcg10;

        const detail = {
          id: tc.id,
          query: tc.query,
          category: tc.category,
          targets: tc.targets,
          rank: metrics.rank,
          topMatch: searchRes.rows[0]?.title || 'No match',
          topSource: searchRes.rows[0]?.source_id || 'None',
          similarity: Number(searchRes.rows[0]?.similarity || 0).toFixed(4),
          retrievedTop5: searchRes.rows.slice(0, 5).map(r => `${r.source_id} (${Number(r.similarity).toFixed(3)})`)
        };

        results[config.name].queryDetails.push(detail);

        if (metrics.rank === null || metrics.rank > 5) {
          results[config.name].failures.push(detail);
        }
      }
    }
  }

  const N_pos = positiveCases.length;
  const summary = configs.map(config => {
    const d = results[config.name];
    const recall1 = (d.hit1Count / N_pos * 100).toFixed(1) + '%';
    const recall5 = (d.hit5Count / N_pos * 100).toFixed(1) + '%';
    const recall10 = (d.hit10Count / N_pos * 100).toFixed(1) + '%';
    const mrr10 = (d.totalRR / N_pos).toFixed(3);
    const ndcg10 = (d.totalNDCG / N_pos).toFixed(3);
    const p5 = (d.totalP5 / N_pos).toFixed(3);

    d.latencies.sort((a, b) => a - b);
    const avgLat = (d.latencies.reduce((s, l) => s + l, 0) / d.latencies.length).toFixed(1) + 'ms';
    const p50Lat = d.latencies[Math.floor(d.latencies.length * 0.50)] + 'ms';
    const p95Lat = d.latencies[Math.floor(d.latencies.length * 0.95)] + 'ms';

    const maxNeg = Math.max(...d.negativeScores.map(n => n.score)).toFixed(3);
    const rejectedNeg = d.negativeScores.filter(n => n.score < 0.45).length;
    const negRejectionRate = (rejectedNeg / negativeCases.length * 100).toFixed(0) + '%';

    return {
      'Configuration': config.name,
      'Recall@1': recall1,
      'Recall@5': recall5,
      'Recall@10': recall10,
      'MRR@10': mrr10,
      'NDCG@10': ndcg10,
      'Precision@5': p5,
      'P50 Latency': p50Lat,
      'P95 Latency': p95Lat,
      'Avg Latency': avgLat,
      'Neg Rejection (<0.45)': negRejectionRate,
      'Max Neg Score': maxNeg,
      'Failures (>Rank 5)': d.failures.length
    };
  });

  console.log('\n========================================================================================');
  console.log('                          FULL CORPUS BENCHMARK FINAL RESULTS                           ');
  console.log('========================================================================================');
  console.table(summary);

  const outPath = path.join(__dirname, 'fullCorpusBenchmarkResults.json');
  fs.writeFileSync(outPath, JSON.stringify({ summary, detailed: results }, null, 2));
  console.log(`\nDetailed report and failure cases saved to: ${outPath}`);

  await client.end();
}

runBenchmark().catch(console.error);
