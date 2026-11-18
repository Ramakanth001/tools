const assert = require('node:assert/strict');
const test = require('node:test');
const { createLexicalRanker, retainStrongQuestionMatch, retainIncumbentPassages } = require('../src/distanceLexicalRanker');

const model = {
  version: 1, features: ['answer.coverage'], coefficients: [1], blend: 0.9,
};
const query = 'Why does God reward devotion?';
const vector = "'devot':5 'god':3 'reward':4";
const initial = [{ answerUnitId: 'incumbent', answerUnitHash: 'i1', totalScore: 100 }];
const row = {
  answer_unit_id: 'addition', answer_hash: 'a1',
  answer_text: 'God rewards devotion.', answer_vector: vector,
};

function mockPool(hydratedHash = row.answer_hash) {
  return {
    calls: [],
    async query(sql) {
      this.calls.push(sql);
      if (sql.includes('SELECT u.answer_unit_id')) {
        return { rows: [row, { answer_unit_id: 'incumbent', answer_hash: 'i1', answer_vector: "'another':1" },
          ...Array.from({ length: 5 }, (_, id) => ({ answer_unit_id: 'other' + id, answer_vector: "'unrel':1" }))] };
      }
      if (sql.includes('unnest')) return { rows: [{ vector }, { vector }] };
      if (sql.includes('ANY')) return { rows: [{ matched_answer_unit_id: 'addition', matched_answer_unit_hash: hydratedHash }] };
      throw new Error('Unexpected query');
    },
  };
}

test('live lexical ranking loads a shared corpus and hydrates a supplemental winner with its current hash', async () => {
  const ranker = createLexicalRanker(model);
  const pool = mockPool();
  const [first, second] = await Promise.all([ranker.prepare(pool), ranker.prepare(pool)]);
  assert.equal(first, second);
  const result = await ranker.rank(pool, query, initial, {
    limit: 1,
    evaluateCandidate(record) {
      assert.equal(record.matched_answer_unit_hash, 'a1');
      return { answerUnitId: record.matched_answer_unit_id, answerUnitHash: record.matched_answer_unit_hash };
    },
  });
  assert.deepEqual(result.rankedAnswerUnitIds, ['addition', 'incumbent']);
  assert.equal(result.matches[0].answerUnitId, 'addition');
  assert.equal(pool.calls.filter(sql => sql.includes('SELECT u.answer_unit_id')).length, 1);
});

test('a stale supplemental citation falls back to the incumbent without scoring the stale record', async () => {
  const pool = mockPool('stale');
  const result = await createLexicalRanker(model).rank(pool, query, initial, {
    limit: 1,
    evaluateCandidate() { assert.fail('Stale text must not be scored'); },
  });
  assert.equal(result.matches[0].answerUnitId, 'incumbent');
});

test('a rejected corpus load can be retried and an unanchored query skips lexical ranking', async () => {
  const ranker = createLexicalRanker(model);
  const pool = mockPool();
  const execute = pool.query.bind(pool);
  let fail = true;
  pool.query = async sql => {
    if (fail) throw new Error('Temporary database error');
    return execute(sql);
  };
  await assert.rejects(ranker.prepare(pool), /Temporary database error/);
  fail = false;
  assert.equal((await ranker.prepare(pool)).documents.size, 7);
  assert.equal(await ranker.rank(pool, 'today', initial, { limit: 1 }), null);
  assert.equal(pool.calls.filter(sql => sql.includes('SELECT u.answer_unit_id')).length, 1);
});

test('a strong incumbent keeps one top-five position while supplemental evidence still picks the first result', () => {
  const incumbent = { answerUnitId: 'question', totalScore: 600000, titleScore: 500000, discoveryScore: 40000 };
  const alternatives = Array.from({ length: 6 }, (_, i) => ({
    answerUnitId: 'passage-' + i, totalScore: 800000, titleScore: 0, discoveryScore: 0, englishPassageScore: 350000,
  }));
  const reranked = [...alternatives, incumbent].map((candidate, i) => ({ candidate, score: 1 - i / 10 }));
  const result = retainStrongQuestionMatch([alternatives[0], ...alternatives.slice(1), incumbent], reranked);
  assert.equal(result[0].candidate, alternatives[0]);
  assert.equal(result[4].candidate, incumbent);
  assert.equal(result[4].score, 0.6);
  assert.equal(new Set(result.map(row => row.candidate)).size, 7);
});

test('a weak incumbent leaves the learned order alone', () => {
  const weak = { answerUnitId: 'unrelated', totalScore: 600000, titleScore: 100000, discoveryScore: 40000 };
  const other = Array.from({ length: 5 }, () => ({ score: 0.2, candidate: {} }));
  const reranked = [...other, { candidate: weak, score: 0.1 }];
  assert.deepEqual(retainStrongQuestionMatch([weak], reranked), [...other, { candidate: weak, score: 0.1 }]);
});

test('passage expansion preserves three incumbent slots while keeping an evidence-backed first result', () => {
  const incumbents = Array.from({ length: 3 }, (_, i) => ({ answerUnitId: 'incumbent-' + i, totalScore: 5 - i }));
  const additions = Array.from({ length: 6 }, (_, i) => ({ answerUnitId: 'additional-' + i,
    totalScore: 11, englishPassageScore: 10 }));
  const rows = [...additions, ...incumbents].map((candidate, index) => ({ candidate, score: 1 - index / 10 }));
  retainIncumbentPassages([...additions, ...incumbents], rows, new Set(incumbents.map(row => row.answerUnitId)));
  assert.equal(rows[0].candidate, additions[0]);
  assert.ok(incumbents.every(candidate => rows.slice(0, 5).some(row => row.candidate === candidate)));
  assert.equal(new Set(rows.map(row => row.candidate)).size, 9);
});
