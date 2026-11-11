const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');
const { normalizeSpiritualText } = require('E:/Universal-Spirituality/tools/semantic-qa/benchmark/spiritualNormalizer');

const OLLAMA_URL = 'http://127.0.0.1:11434';

async function getEmbedding(model, text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  const data = await res.json();
  return data.embedding;
}

function toVectorLiteral(arr) {
  return `[${arr.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

// 1. Production baseline search (untouched production semantic_qa index)
async function searchProductionBaseline(client, queryVector, topK = 10) {
  const t0 = Date.now();
  const res = await client.query(`
    WITH dense AS (
      SELECT source_id, passage_index, 1 - (embedding <=> $1::vector) as similarity
      FROM semantic_qa.passages
      ORDER BY embedding <=> $1::vector
      LIMIT $2 * 4
    )
    SELECT d.source_id, max(d.similarity) as similarity, r.question as title
    FROM dense d
    JOIN semantic_qa.records r USING (source_id)
    GROUP BY d.source_id, r.question
    ORDER BY similarity DESC
    LIMIT $2
  `, [toVectorLiteral(queryVector), topK]);
  const latency = Date.now() - t0;
  return { rows: res.rows, latency };
}

// 2. Dense search on benchmark schema with Document Diversity (Group by source_id)
async function searchDense(client, tableName, queryVector, topK = 10) {
  const t0 = Date.now();
  const res = await client.query(`
    WITH ranked AS (
      SELECT p.source_id, 1 - (p.embedding <=> $1::vector) as similarity,
             doc.title, p.passage_text,
             ROW_NUMBER() OVER (PARTITION BY p.source_id ORDER BY p.embedding <=> $1::vector) as rn
      FROM semantic_qa_bench.${tableName} p
      JOIN semantic_qa_bench.documents doc ON doc.document_id = p.source_id
      ORDER BY p.embedding <=> $1::vector
      LIMIT 100
    )
    SELECT source_id, similarity, title, passage_text as best_passage
    FROM ranked
    WHERE rn = 1
    ORDER BY similarity DESC
    LIMIT $2
  `, [toVectorLiteral(queryVector), topK]);
  const latency = Date.now() - t0;
  return { rows: res.rows, latency };
}

// 3. Naive Hybrid RRF search (reproducing benchmark baseline)
async function searchNaiveRRF(client, tableName, queryVector, queryText, topK = 10, rrfK = 60) {
  const t0 = Date.now();
  const res = await client.query(`
    WITH query AS (
      SELECT websearch_to_tsquery('simple'::regconfig, $3) as terms
    ),
    dense_ranked AS (
      SELECT p.source_id,
             row_number() OVER (ORDER BY p.embedding <=> $1::vector) as rank_dense,
             1 - (p.embedding <=> $1::vector) as sim_dense,
             p.passage_text
      FROM semantic_qa_bench.${tableName} p
      ORDER BY p.embedding <=> $1::vector
      LIMIT 100
    ),
    lexical_ranked AS (
      SELECT p.source_id,
             row_number() OVER (ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC) as rank_lexical,
             ts_rank_cd(p.search_vector, q.terms) as score_lexical
      FROM semantic_qa_bench.${tableName} p, query q
      WHERE q.terms::text <> '' AND p.search_vector @@ q.terms
      ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC
      LIMIT 100
    ),
    combined AS (
      SELECT coalesce(d.source_id, l.source_id) as source_id,
             coalesce(1.0 / ($4 + d.rank_dense), 0.0) +
             coalesce(1.0 / ($4 + l.rank_lexical), 0.0) as rrf_score,
             coalesce(d.sim_dense, 0.0) as sim_dense,
             coalesce(l.score_lexical, 0.0) as score_lexical,
             d.passage_text
      FROM dense_ranked d
      FULL OUTER JOIN lexical_ranked l ON d.source_id = l.source_id
    )
    SELECT c.source_id, c.rrf_score as similarity, c.sim_dense, c.score_lexical, doc.title,
           (array_agg(c.passage_text ORDER BY c.rrf_score DESC))[1] as best_passage
    FROM combined c
    JOIN semantic_qa_bench.documents doc ON doc.document_id = c.source_id
    GROUP BY c.source_id, c.rrf_score, c.sim_dense, c.score_lexical, doc.title
    ORDER BY c.rrf_score DESC
    LIMIT $2
  `, [toVectorLiteral(queryVector), topK, queryText, rrfK]);
  const latency = Date.now() - t0;
  return { rows: res.rows, latency };
}

// 4. Calibrated Hybrid Search (Dense + Lexical + Spiritual Normalization + Diversity)
async function searchCalibratedHybrid(client, queryVector, normalizedQuery, topK = 10) {
  const t0 = Date.now();
  const res = await client.query(`
    WITH dense_candidates AS (
      SELECT p.source_id, p.passage_index,
             1 - (p.embedding <=> $1::vector) as sim_dense,
             p.passage_text, doc.title
      FROM semantic_qa_bench.passages_bgem3 p
      JOIN semantic_qa_bench.documents doc ON doc.document_id = p.source_id
      ORDER BY p.embedding <=> $1::vector
      LIMIT 80
    ),
    lexical_scored AS (
      SELECT d.source_id, d.passage_index, d.sim_dense, d.passage_text, d.title,
             ts_rank_cd(
               setweight(to_tsvector('english', d.title), 'A') ||
               setweight(to_tsvector('english', d.passage_text), 'B'),
               plainto_tsquery('english', $2)
             ) as score_lexical
      FROM dense_candidates d
    ),
    combined AS (
      SELECT source_id, title, passage_text,
             sim_dense + (0.15 * LEAST(1.0, score_lexical * 2.0)) as calibrated_score,
             sim_dense, score_lexical,
             ROW_NUMBER() OVER (
               PARTITION BY source_id
               ORDER BY (sim_dense + 0.15 * LEAST(1.0, score_lexical * 2.0)) DESC
             ) as rn
      FROM lexical_scored
    )
    SELECT source_id, calibrated_score as similarity, sim_dense, score_lexical, title, passage_text as best_passage
    FROM combined
    WHERE rn = 1
    ORDER BY calibrated_score DESC
    LIMIT $3;
  `, [toVectorLiteral(queryVector), normalizedQuery, topK]);
  const latency = Date.now() - t0;
  return { rows: res.rows, latency };
}

// Evaluation Metrics Computation
function computeIRMetrics(retrievedRows, targetIds) {
  if (!targetIds || !targetIds.length) {
    return { hit1: 0, hit5: 0, hit10: 0, rr: 0, p5: 0, ndcg10: 0, rank: null };
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
      dcg10 += 1 / Math.log2(i + 2); // i+2 because rank i=0 is position 1, log2(1+1)=1
    }
  }

  // Calculate Ideal DCG@10 (IDCG)
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
  };
}

async function runExpandedBenchmark() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_index' });
  await client.connect();

  const testCases = require('./expandedTestCases.json');
  console.log(`Loaded ${testCases.length} total test cases.`);

  const positiveCases = testCases.filter(c => !c.isNegative);
  const negativeCases = testCases.filter(c => c.isNegative);
  console.log(`- Positive evaluation cases: ${positiveCases.length}`);
  console.log(`- Negative control cases:   ${negativeCases.length}\n`);

  const configs = [
    { name: '1. Prod Baseline (Legacy Empty-Title & Micro-Chunks)', type: 'prod' },
    { name: '2. EmbeddingGemma Dense-Only (768d + Context Injection)', type: 'dense_gemma', table: 'passages_gemma', model: 'embeddinggemma' },
    { name: '3. BGE-M3 Dense-Only (1024d + Context Injection)', type: 'dense_bgem3', table: 'passages_bgem3', model: 'bge-m3' },
    { name: '4. Hybrid RRF Naive (BGE-M3 + Postgres Simple FTS)', type: 'naive_rrf', table: 'passages_bgem3', model: 'bge-m3' },
    { name: '5. Calibrated Hybrid Fusion (BGE-M3 + FTS + Normalizer + Diversity)', type: 'calibrated_hybrid', table: 'passages_bgem3', model: 'bge-m3' },
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
    };
  }

  let progress = 0;
  for (const tc of testCases) {
    progress++;
    if (progress % 15 === 0 || progress === testCases.length) {
      console.log(`Progress: [${progress}/${testCases.length}] test cases evaluated...`);
    }

    const normQuery = normalizeSpiritualText(tc.query);
    const gemmaQueryText = `task: question answering | query: ${normQuery}`;
    const gemmaVec = await getEmbedding('embeddinggemma', gemmaQueryText);
    const bgem3Vec = await getEmbedding('bge-m3', normQuery);

    for (const config of configs) {
      let searchRes;
      if (config.type === 'prod') {
        searchRes = await searchProductionBaseline(client, gemmaVec, 10);
      } else if (config.type === 'dense_gemma') {
        searchRes = await searchDense(client, config.table, gemmaVec, 10);
      } else if (config.type === 'dense_bgem3') {
        searchRes = await searchDense(client, config.table, bgem3Vec, 10);
      } else if (config.type === 'naive_rrf') {
        searchRes = await searchNaiveRRF(client, config.table, bgem3Vec, tc.query, 10);
      } else if (config.type === 'calibrated_hybrid') {
        searchRes = await searchCalibratedHybrid(client, bgem3Vec, normQuery, 10);
      }

      results[config.name].latencies.push(searchRes.latency);

      if (tc.isNegative) {
        const topScore = Number(searchRes.rows[0]?.similarity ?? 0);
        results[config.name].negativeScores.push(topScore);
      } else {
        const metrics = computeIRMetrics(searchRes.rows, tc.targets);
        results[config.name].ranks.push(metrics.rank);
        results[config.name].hit1Count += metrics.hit1;
        results[config.name].hit5Count += metrics.hit5;
        results[config.name].hit10Count += metrics.hit10;
        results[config.name].totalRR += metrics.rr;
        results[config.name].totalP5 += metrics.p5;
        results[config.name].totalNDCG += metrics.ndcg10;

        results[config.name].queryDetails.push({
          id: tc.id,
          query: tc.query,
          category: tc.category,
          rank: metrics.rank,
          topMatch: searchRes.rows[0]?.title || 'No match',
          topSource: searchRes.rows[0]?.source_id || 'None',
          similarity: Number(searchRes.rows[0]?.similarity || 0).toFixed(4),
        });
      }
    }
  }

  // Compile Comprehensive Summary
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

    const maxNeg = Math.max(...d.negativeScores).toFixed(3);
    const rejectedNeg = d.negativeScores.filter(s => s < 0.45).length;
    const negRejectionRate = (rejectedNeg / negativeCases.length * 100).toFixed(0) + '%';

    return {
      'Configuration': config.name,
      'Recall@1': recall1,
      'Recall@5': recall5,
      'Recall@10': recall10,
      'MRR@10': mrr10,
      'NDCG@10': ndcg10,
      'Precision@5': p5,
      'Avg Latency': avgLat,
      'P95 Latency': p95Lat,
      'Neg Rejection (<0.45)': negRejectionRate,
      'Max Neg Sim': maxNeg,
    };
  });

  console.log('\n========================================================================================');
  console.log('                          EXPANDED BENCHMARK FINAL RESULTS TABLE                        ');
  console.log(`            Evaluated across ${testCases.length} Queries (${N_pos} Positive + ${negativeCases.length} Negative Controls)           `);
  console.log('========================================================================================');
  console.table(summary);

  const outputPath = path.join(__dirname, 'expandedEvaluationResults.json');
  fs.writeFileSync(outputPath, JSON.stringify({ summary, detailed: results }, null, 2));
  console.log(`\nDetailed per-query results saved to: ${outputPath}`);

  await client.end();
}

runExpandedBenchmark().catch(console.error);
