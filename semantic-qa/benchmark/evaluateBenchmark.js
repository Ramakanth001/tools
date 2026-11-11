const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('E:/Universal-Spirituality/tools/node_modules/pg');

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

// 1. Production baseline search (queries the untouched production semantic_qa index)
async function searchProductionBaseline(client, question, queryVector, topK = 10) {
  const t0 = Date.now();
  // Using the production logic
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

// 2. Dense search on benchmark schema
async function searchDense(client, tableName, queryVector, topK = 10) {
  const t0 = Date.now();
  const res = await client.query(`
    WITH dense AS (
      SELECT p.source_id, p.passage_index, 1 - (p.embedding <=> $1::vector) as similarity, p.passage_text
      FROM semantic_qa_bench.${tableName} p
      ORDER BY p.embedding <=> $1::vector
      LIMIT $2 * 4
    )
    SELECT d.source_id, max(d.similarity) as similarity, doc.title,
           (array_agg(d.passage_text ORDER BY d.similarity DESC))[1] as best_passage
    FROM dense d
    JOIN semantic_qa_bench.documents doc ON doc.document_id = d.source_id
    GROUP BY d.source_id, doc.title
    ORDER BY similarity DESC
    LIMIT $2
  `, [toVectorLiteral(queryVector), topK]);
  const latency = Date.now() - t0;
  return { rows: res.rows, latency };
}

// 3. Hybrid RRF search on benchmark schema (Dense + Full-Text Search)
async function searchHybridRRF(client, tableName, queryVector, queryText, topK = 10, rrfK = 60) {
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
    SELECT c.source_id, c.rrf_score, c.sim_dense, c.score_lexical, doc.title,
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

// Evaluation Test Cases
const TEST_CASES = [
  // Spiritual core questions with known ground-truth targets
  {
    query: "Who is Datta Swami?",
    targets: ["discourse:737", "discourse:891", "discourse:702", "discourse:1322", "discourse:738", "discourse:2865", "discourse:727", "discourse:2753", "discourse:4345", "qa:233"],
    category: "Theology"
  },
  {
    query: "What is the real nature of Datta?",
    targets: ["qa:49", "discourse:550", "discourse:879", "discourse:816"],
    category: "Theology"
  },
  {
    query: "What is the difference between Lord Datta and Lord Dattatreya?",
    targets: ["discourse:2068", "discourse:675", "discourse:415", "discourse:5173"],
    category: "Theology"
  },
  {
    query: "Why do my prayers go unanswered?",
    targets: ["qa:159", "discourse:3463", "discourse:4513", "qa:98", "discourse:782"],
    category: "Philosophy"
  },
  {
    query: "Is the world real or an illusion?",
    targets: ["qa:60", "discourse:2496", "discourse:1526", "discourse:4034", "discourse:708", "discourse:1523"],
    category: "Philosophy"
  },
  {
    query: "What is the difference between Nivrutti and Pravrutti?",
    targets: ["discourse:4705", "discourse:713", "discourse:5706", "discourse:1153"],
    category: "Philosophy"
  },
  {
    query: "How can I serve Swami?",
    targets: ["qa:323", "discourse:728", "discourse:5594", "discourse:3037"],
    category: "Practice"
  },
  {
    query: "should we use oil based lamp?",
    targets: ["discourse:1841", "discourse:533", "discourse:1118", "qa:144", "discourse:1690", "discourse:383"],
    category: "Rituals"
  },
  {
    query: "What is the meaning of Jesus saying \"The light is in me\"?",
    targets: ["discourse:1199", "discourse:1322", "discourse:228", "discourse:1008", "discourse:3427"],
    category: "Universal"
  },
  {
    query: "Question on test conduted by Lord Datta.",
    targets: ["qa:421", "discourse:707", "qa:87", "discourse:4486", "discourse:80"],
    category: "Theology"
  },
  // Transliteration variants
  {
    query: "How does Jñāna lead to Moksha?",
    targets: ["discourse:879", "discourse:5706", "discourse:817", "discourse:1322"],
    category: "Transliteration (IAST)"
  },
  {
    query: "How does Gyana lead to Moksham?",
    targets: ["discourse:879", "discourse:5706", "discourse:817", "discourse:1322"],
    category: "Transliteration (Phonetic)"
  },
  // Bhagavat Gita recovered chapters test
  {
    query: "Secret of unimaginable God Datta revealed by Scripture",
    targets: ["discourse:879"],
    category: "Recovered Gita Chapters"
  },
  // Multilingual queries
  {
    query: "ఆధ్యాత్మిక మార్గంలో గురువు పాత్ర ఏమిటి?",
    targets: ["discourse:2700", "discourse:2701", "discourse:2702", "discourse:2703", "discourse:2704"],
    category: "Telugu"
  },
  {
    query: "ദൈവത്തിൽ നിന്ന് ആഗ്രഹിക്കുന്നതിനേക്കാൾ ദൈവം നമ്മിൽ നിന്ന് എന്താണ് ആഗ്രഹിക്കുന്നത്?",
    targets: ["discourse:3000", "discourse:3001", "discourse:3002", "discourse:3003"],
    category: "Malayalam"
  },
  // Negative controls (out-of-domain)
  {
    query: "What is the capital of France?",
    targets: [],
    isNegative: true,
    category: "Negative Control"
  },
  {
    query: "How do I bake a chocolate cake?",
    targets: [],
    isNegative: true,
    category: "Negative Control"
  },
  {
    query: "Who won the 2026 FIFA World Cup?",
    targets: [],
    isNegative: true,
    category: "Negative Control"
  }
];

function evaluateRank(matchedRows, targetIds) {
  if (!targetIds || !targetIds.length) return null;
  const matchIds = matchedRows.map(r => r.source_id);
  for (let i = 0; i < matchIds.length; i++) {
    if (targetIds.includes(matchIds[i])) {
      return i + 1; // 1-based rank
    }
  }
  return null;
}

async function runEvaluation() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_index' });
  await client.connect();

  console.log('=== Starting Rigorous Benchmark Evaluation ===\n');

  const configs = [
    { name: 'Prod Baseline (Empty-Title Vectors & Micro-Chunks)', type: 'prod' },
    { name: 'EmbeddingGemma (Context-Injected, Dense-Only)', type: 'bench_dense_gemma', table: 'passages_gemma', model: 'embeddinggemma' },
    { name: 'BGE-M3 (Context-Injected, Dense-Only)', type: 'bench_dense_bgem3', table: 'passages_bgem3', model: 'bge-m3' },
    { name: 'Hybrid RRF (EmbeddingGemma + Full-Text)', type: 'bench_rrf_gemma', table: 'passages_gemma', model: 'embeddinggemma' },
    { name: 'Hybrid RRF (BGE-M3 + Full-Text)', type: 'bench_rrf_bgem3', table: 'passages_bgem3', model: 'bge-m3' },
  ];

  const results = {};
  for (const c of configs) {
    results[c.name] = {
      ranks: [],
      top1Hits: 0,
      top5Hits: 0,
      top10Hits: 0,
      latencies: [],
      reciprocalRanks: [],
      negativeScores: [],
      queryDetails: [],
    };
  }

  const positiveCases = TEST_CASES.filter(c => !c.isNegative);
  const negativeCases = TEST_CASES.filter(c => c.isNegative);

  for (const tc of TEST_CASES) {
    // Generate vectors for both models
    const gemmaQueryText = `task: question answering | query: ${tc.query}`;
    const gemmaVec = await getEmbedding('embeddinggemma', gemmaQueryText);
    const bgem3Vec = await getEmbedding('bge-m3', tc.query);

    for (const config of configs) {
      let searchRes;
      if (config.type === 'prod') {
        searchRes = await searchProductionBaseline(client, tc.query, gemmaVec, 10);
      } else if (config.type === 'bench_dense_gemma') {
        searchRes = await searchDense(client, config.table, gemmaVec, 10);
      } else if (config.type === 'bench_dense_bgem3') {
        searchRes = await searchDense(client, config.table, bgem3Vec, 10);
      } else if (config.type === 'bench_rrf_gemma') {
        searchRes = await searchHybridRRF(client, config.table, gemmaVec, tc.query, 10);
      } else if (config.type === 'bench_rrf_bgem3') {
        searchRes = await searchHybridRRF(client, config.table, bgem3Vec, tc.query, 10);
      }

      results[config.name].latencies.push(searchRes.latency);

      if (tc.isNegative) {
        // Record max similarity score for negative control query
        const maxScore = searchRes.rows[0]?.similarity ?? searchRes.rows[0]?.sim_dense ?? 0;
        results[config.name].negativeScores.push(maxScore);
      } else {
        const rank = evaluateRank(searchRes.rows, tc.targets);
        results[config.name].ranks.push(rank);
        if (rank === 1) results[config.name].top1Hits += 1;
        if (rank !== null && rank <= 5) results[config.name].top5Hits += 1;
        if (rank !== null && rank <= 10) results[config.name].top10Hits += 1;
        results[config.name].reciprocalRanks.push(rank ? 1 / rank : 0);

        results[config.name].queryDetails.push({
          query: tc.query,
          category: tc.category,
          rank,
          topMatch: searchRes.rows[0]?.title || 'No match',
          topSource: searchRes.rows[0]?.source_id || 'None',
          snippet: (searchRes.rows[0]?.best_passage || '').slice(0, 100),
        });
      }
    }
  }

  // Compile Summary Report
  const summary = configs.map(config => {
    const data = results[config.name];
    const totalPositive = positiveCases.length;
    const recallAt1 = (data.top1Hits / totalPositive * 100).toFixed(1) + '%';
    const recallAt5 = (data.top5Hits / totalPositive * 100).toFixed(1) + '%';
    const recallAt10 = (data.top10Hits / totalPositive * 100).toFixed(1) + '%';
    const mrr = (data.reciprocalRanks.reduce((s, r) => s + r, 0) / totalPositive).toFixed(3);
    const avgLatency = (data.latencies.reduce((s, l) => s + l, 0) / data.latencies.length).toFixed(1) + 'ms';
    const maxNegSim = (Math.max(...data.negativeScores)).toFixed(3);

    return {
      Configuration: config.name,
      'Recall@1': recallAt1,
      'Recall@5': recallAt5,
      'Recall@10': recallAt10,
      'MRR@10': mrr,
      'Avg Latency': avgLatency,
      'Max Neg Score': maxNegSim,
    };
  });

  console.log('=== BENCHMARK EVALUATION RESULTS TABLE ===');
  console.table(summary);

  // Write detailed results to JSON
  fs.writeFileSync(path.join(__dirname, 'evaluationResults.json'), JSON.stringify({ summary, detailed: results }, null, 2));
  console.log(`Saved evaluation results to ${path.join(__dirname, 'evaluationResults.json')}`);

  await client.end();
}

runEvaluation().catch(console.error);
