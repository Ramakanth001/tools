const test = require('node:test');
const assert = require('node:assert/strict');
const { CorpusReader, quotedPhrases, toVectorLiteral, sameFingerprint, completeAnswerUnit } = require('../src/corpus');

test('query literals and exact phrases are normalized defensively', () => {
  assert.equal(toVectorLiteral([0, 1.5, -2]), '[0,1.5,-2]');
  assert.throws(() => toVectorLiteral([0, Number.NaN]), /invalid/);
  assert.deepEqual(quotedPhrases('What does “The light is in me” mean?'), ['The light is in me']);
  assert.deepEqual(quotedPhrases('What is the best way to reach God?'), []);
});

test('probe fusion deduplicates passages and caps each source group at three', () => {
  const reader = new CorpusReader();
  const rows = Array.from({ length: 5 }, (_, index) => ({
    sourceId: `s${index}`, sourceGroup: 'one-book', passageIndex: 0, similarity: 0.9 - index * 0.01,
    lexicalScore: 0.1, channels: ['dense'],
  }));
  const fused = reader.fuseProbeResults([
    { probe: { text: 'first', purpose: 'primary' }, rows },
    { probe: { text: 'second', purpose: 'relationship' }, rows: [rows[0]] },
  ]);
  assert.equal(fused.length, 3);
  assert.equal(fused[0].sourceId, 's0');
  assert.equal(fused[0].probes.length, 2);
});

test('evidence identity validation rejects offsets that do not reproduce the excerpt', async () => {
  const reader = new CorpusReader();
  reader.holder.pool = { query: async () => ({ rows: [{ sourceId: 's1', answer: 'before exact evidence after' }] }) };
  await assert.doesNotReject(() => reader.validateEvidence([{ evidenceId: 'E1', sourceId: 's1', start: 7, end: 21, excerpt: 'exact evidence' }]));
  await assert.rejects(() => reader.validateEvidence([{ evidenceId: 'E1', sourceId: 's1', start: 7, end: 21, excerpt: 'different text' }]), /no longer matches/);
});

test('corpus fingerprints include index identity and synchronization state', () => {
  const base = { retrievalSchemaVersion: 'answer-unit-v5', embeddingFormatVersion: 'embeddinggemma-asymmetric-v3', embeddingModel: 'embeddinggemma', embeddingModelDigest: 'd', embeddingDimension: 768, recordCount: 10, lastSyncedAt: '2026-01-01T00:00:00Z' };
  assert.equal(sameFingerprint(base, { ...base }), true);
  assert.equal(sameFingerprint(base, { ...base, recordCount: 11 }), false);
});

test('context expansion casts arithmetic parameters for PostgreSQL', async () => {
  const reader = new CorpusReader();
  let statement = '';
  reader.holder.pool = { query: async (sql) => { statement = sql; return { rows: [] }; } };
  await reader.expandEvidence({ sourceId: 's1', passageIndex: 2 }, 1);
  assert.match(statement, /\$2::integer - \$3::integer/);
  assert.match(statement, /\$2::integer \+ \$3::integer/);
});

test('source viewer highlights the exact cited answer span instead of the whole matching passage', async () => {
  const reader = new CorpusReader();
  const answer = 'Question text?\nSwami Replied:- Exact answer from the corpus.';
  reader.holder.pool = { query: async (sql) => {
    if (/WITH resolved AS/u.test(sql)) {
      return { rows: [{ sourceId: 's1', sourceGroup: null, title: 'Question text?', metadata: {} }] };
    }
    if (/SELECT source_id AS "sourceId", question AS title, answer/u.test(sql)) {
      return { rows: [{ sourceId: 's1', title: 'Question text?', answer, metadata: {}, sourceOrder: 1 }] };
    }
    throw new Error('The passage fallback should not run for a valid exact answer span');
  } };
  const start = answer.indexOf('Swami Replied:-');
  const source = await reader.getSource('s1', 0, start, answer.length);
  assert.equal(source.highlight.excerpt, 'Swami Replied:- Exact answer from the corpus.');
  assert.equal(source.highlight.exactAnswerSpan, true);
  assert.equal(source.highlight.start, start);
});

test('complete answer reconstruction excludes every record before the explicit reply', () => {
  const records = [
    { sourceId: 'discourse:1:001', sourceGroup: 'discourse:1', sourceOrder: 1, title: 'A long question?',
      answer: '[A devotee described a job search. I tried to replicate it and succeeded in getting a decent job.', metadata: { chunk_index: 1 } },
    { sourceId: 'discourse:1:002', sourceGroup: 'discourse:1', sourceOrder: 2, title: 'A long question?',
      answer: 'More question text asking about worldly success.]\n\nSwami Replied:- You can concentrate on worldly life. Whenever you find time, divert it towards God.', metadata: { chunk_index: 2 } },
  ];
  const unit = completeAnswerUnit(records, { sourceGroup: 'discourse:1' });
  assert.equal(unit.answerBoundary, 'explicit_reply');
  assert.equal(unit.segments.length, 1);
  assert.equal(unit.segments[0].sourceId, 'discourse:1:002');
  assert.equal(unit.segments[0].excerpt, 'You can concentrate on worldly life. Whenever you find time, divert it towards God.');
  assert.doesNotMatch(unit.completeAnswer, /decent job|question text|Swami Replied/iu);
});

test('complete answer reconstruction reads later answer chunks and removes overlapping quotations', () => {
  const first = 'The direct reply begins here. One should love God without aspiration for any fruit in return.';
  const overlap = 'without aspiration for any fruit in return.';
  const later = `${overlap}\n\nWhen faced with a problem, the real devotee has true love for God without aspiration for any fruit in return.`;
  const unit = completeAnswerUnit([
    { sourceId: 's:001', sourceGroup: 's', sourceOrder: 1, title: 'Should one ask?',
      answer: `[A devotee asked for a benefit.]\n\nSwami replied: ${first}`, metadata: { chunk_index: 1 } },
    { sourceId: 's:002', sourceGroup: 's', sourceOrder: 2, title: 'Should one ask?', answer: later, metadata: { chunk_index: 2 } },
  ], { sourceGroup: 's' });
  assert.equal(unit.segments.length, 2);
  assert.match(unit.completeAnswer, /The direct reply begins here/u);
  assert.match(unit.completeAnswer, /When faced with a problem/u);
  assert.equal((unit.completeAnswer.match(/without aspiration for any fruit in return\./gu) || []).length, 2);
  assert.equal(unit.segments[1].start, later.indexOf('When'));
  assert.equal(unit.segments[1].excerpt.startsWith('When faced with a problem'), true);
});
