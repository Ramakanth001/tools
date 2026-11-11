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

const TEST_CASES = [
  {
    query: "Who is Datta Swami?",
    targets: ["discourse:737", "discourse:891", "discourse:702", "discourse:1322", "discourse:738", "discourse:2865", "discourse:727", "discourse:2753", "discourse:4345", "qa:233"]
  },
  {
    query: "What is the real nature of Datta?",
    targets: ["qa:49", "discourse:550", "discourse:879", "discourse:816"]
  },
  {
    query: "What is the difference between Lord Datta and Lord Dattatreya?",
    targets: ["discourse:2068", "discourse:675", "discourse:415", "discourse:5173"]
  },
  {
    query: "Why do my prayers go unanswered?",
    targets: ["qa:159", "discourse:3463", "discourse:4513", "qa:98", "discourse:782"]
  },
  {
    query: "Is the world real or an illusion?",
    targets: ["qa:60", "discourse:2496", "discourse:1526", "discourse:4034", "discourse:708", "discourse:1523"]
  },
  {
    query: "What is the difference between Nivrutti and Pravrutti?",
    targets: ["discourse:4705", "discourse:713", "discourse:5706", "discourse:1153"]
  },
  {
    query: "How can I serve Swami?",
    targets: ["qa:323", "discourse:728", "discourse:5594", "discourse:3037"]
  },
  {
    query: "should we use oil based lamp?",
    targets: ["discourse:1841", "discourse:533", "discourse:1118", "qa:144", "discourse:1690", "discourse:383"]
  },
  {
    query: "What is the meaning of Jesus saying \"The light is in me\"?",
    targets: ["discourse:1199", "discourse:1322", "discourse:228", "discourse:1008", "discourse:3427"]
  },
  {
    query: "Question on test conduted by Lord Datta.",
    targets: ["qa:421", "discourse:707", "qa:87", "discourse:4486", "discourse:80"]
  },
  {
    query: "Secret of unimaginable God Datta revealed by Scripture",
    targets: ["discourse:879"] // Chapter 9 of Gita (was 0 answer units in prod!)
  }
];

function findRank(rows, targets) {
  const ids = rows.map(r => r.source_id);
  for (let i = 0; i < ids.length; i++) {
    if (targets.includes(ids[i])) return i + 1;
  }
  return null;
}

async function run() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'universal_qa_index' });
  await client.connect();

  console.log('--- Preliminary Head-to-Head: Production vs Context-Injected Gemma ---');
  const results = [];

  for (const tc of TEST_CASES) {
    const prompt = `task: question answering | query: ${tc.query}`;
    const vec = await getEmbedding('embeddinggemma', prompt);
    const vecLit = toVectorLiteral(vec);

    // 1. Prod Baseline
    const prodRes = await client.query(`
      WITH dense AS (
        SELECT source_id, passage_index, 1 - (embedding <=> $1::vector) as similarity
        FROM semantic_qa.passages
        ORDER BY embedding <=> $1::vector
        LIMIT 40
      )
      SELECT d.source_id, max(d.similarity) as similarity, r.question as title
      FROM dense d
      JOIN semantic_qa.records r USING (source_id)
      GROUP BY d.source_id, r.question
      ORDER BY similarity DESC
      LIMIT 10
    `, [vecLit]);

    // 2. Bench Gemma Dense (Context-Injected + Smart Chunks)
    const gemmaDenseRes = await client.query(`
      WITH dense AS (
        SELECT p.source_id, p.passage_index, 1 - (p.embedding <=> $1::vector) as similarity, p.passage_text
        FROM semantic_qa_bench.passages_gemma p
        ORDER BY p.embedding <=> $1::vector
        LIMIT 40
      )
      SELECT d.source_id, max(d.similarity) as similarity, doc.title,
             (array_agg(d.passage_text ORDER BY d.similarity DESC))[1] as snippet
      FROM dense d
      JOIN semantic_qa_bench.documents doc ON doc.document_id = d.source_id
      GROUP BY d.source_id, doc.title
      ORDER BY similarity DESC
      LIMIT 10
    `, [vecLit]);

    // 3. Bench Gemma Hybrid RRF (Dense + Full-Text)
    const gemmaRrfRes = await client.query(`
      WITH query AS (
        SELECT websearch_to_tsquery('simple'::regconfig, $2) as terms
      ),
      dense_ranked AS (
        SELECT p.source_id,
               row_number() OVER (ORDER BY p.embedding <=> $1::vector) as rank_dense,
               1 - (p.embedding <=> $1::vector) as sim_dense,
               p.passage_text
        FROM semantic_qa_bench.passages_gemma p
        ORDER BY p.embedding <=> $1::vector
        LIMIT 80
      ),
      lexical_ranked AS (
        SELECT p.source_id,
               row_number() OVER (ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC) as rank_lexical
        FROM semantic_qa_bench.passages_gemma p, query q
        WHERE q.terms::text <> '' AND p.search_vector @@ q.terms
        ORDER BY ts_rank_cd(p.search_vector, q.terms) DESC
        LIMIT 80
      ),
      combined AS (
        SELECT coalesce(d.source_id, l.source_id) as source_id,
               coalesce(1.0 / (60 + d.rank_dense), 0.0) +
               coalesce(1.0 / (60 + l.rank_lexical), 0.0) as rrf_score,
               d.passage_text
        FROM dense_ranked d
        FULL OUTER JOIN lexical_ranked l ON d.source_id = l.source_id
      )
      SELECT c.source_id, c.rrf_score, doc.title,
             (array_agg(c.passage_text ORDER BY c.rrf_score DESC))[1] as snippet
      FROM combined c
      JOIN semantic_qa_bench.documents doc ON doc.document_id = c.source_id
      GROUP BY c.source_id, c.rrf_score, doc.title
      ORDER BY c.rrf_score DESC
      LIMIT 10
    `, [vecLit, tc.query]);

    const prodRank = findRank(prodRes.rows, tc.targets);
    const denseRank = findRank(gemmaDenseRes.rows, tc.targets);
    const rrfRank = findRank(gemmaRrfRes.rows, tc.targets);

    results.push({
      Query: tc.query.slice(0, 35) + '...',
      'Prod Rank': prodRank ? `#${prodRank}` : 'MISSED',
      'Smart Dense Rank': denseRank ? `#${denseRank}` : 'MISSED',
      'Hybrid RRF Rank': rrfRank ? `#${rrfRank}` : 'MISSED',
      'Prod Top 1': prodRes.rows[0]?.title?.slice(0, 25) || 'None',
      'RRF Top 1': gemmaRrfRes.rows[0]?.title?.slice(0, 25) || 'None',
    });
  }

  console.table(results);
  await client.end();
}

run().catch(console.error);
