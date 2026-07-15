const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NO_MATCH_MESSAGE,
  assertIdentifier,
  buildDocumentEmbeddingText,
  buildEmbeddingText,
  buildLexicalQuery,
  buildQueryEmbeddingText,
  contentHash,
  buildSearchResponse,
  orderMatches,
  redactConnection,
  rerankMatches,
  toVectorLiteral,
} = require('../src/core');

test('builds a labeled question and answer embedding input without rewriting text', () => {
  assert.equal(buildEmbeddingText('Why?  ', 'Because.\nNext line.'), 'Question:\nWhy?  \n\nAnswer:\nBecause.\nNext line.');
  assert.equal(
    buildDocumentEmbeddingText('Who is Swami?', 'Stored answer.', { model: 'embeddinggemma' }),
    'title: Who is Swami? | text: Stored answer.',
  );
  assert.equal(
    buildQueryEmbeddingText('Who is Swami?', { model: 'embeddinggemma' }),
    'task: question answering | query: Who is Swami?',
  );
  assert.equal(buildLexicalQuery('Who is Datta Swami?'), 'datta swami');
});

test('hybrid reranking respects question intent, chooses the answering sibling, and deduplicates groups', () => {
  const rows = [
    {
      sourceId: 'where', question: 'Where can I meet Datta Swami?', answer: 'Call this phone number.',
      similarity: 0.71, lexicalScore: 0.2, sourceGroup: 'where', metadata: { chunk_index: 1 },
    },
    {
      sourceId: 'who:009', question: 'WHO IS SWAMI?', answer: 'A devotee founded the Mission.',
      similarity: 0.70, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 9 },
    },
    {
      sourceId: 'who:001', question: 'WHO IS SWAMI?', answer: 'My name is Venu Gopala Krishna Murthy.',
      similarity: 0.62, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 1 },
    },
  ];
  const matches = rerankMatches(rows, 'Who is Datta Swami?', 5);
  assert.equal(matches[0].sourceId, 'who:001');
  assert.equal(matches.filter((row) => row.sourceGroup === 'who').length, 1);
  assert.ok(matches[0].relevanceScore > matches[1].relevanceScore);
});

test('content hashes are stable and change with source content', () => {
  const base = { sourceId: '1', question: 'Q', answer: 'A', metadata: { chapter: 2 }, sourceGroup: 'g', sourceOrder: 1 };
  assert.equal(contentHash(base), contentHash({ ...base }));
  assert.notEqual(contentHash(base), contentHash({ ...base, answer: 'Changed' }));
});

test('identifiers and vector values are validated', () => {
  assert.equal(assertIdentifier('qa_records'), 'qa_records');
  assert.throws(() => assertIdentifier('qa.records'), /standard PostgreSQL identifier/);
  assert.equal(toVectorLiteral([0.1, -2, 3]), '[0.1,-2,3]');
  assert.throws(() => toVectorLiteral([Number.NaN]), /invalid vector/);
});

test('matches retain relevance ranks while related records follow source order', () => {
  const ordered = orderMatches([
    { sourceId: 'b', similarity: 0.91, sourceGroup: 'chapter', sourceOrder: 2 },
    { sourceId: 'a', similarity: 0.90, sourceGroup: 'chapter', sourceOrder: 1 },
    { sourceId: 'c', similarity: 0.80, sourceGroup: 'other', sourceOrder: 1 },
  ]);
  assert.deepEqual(ordered.map((row) => row.sourceId), ['a', 'b', 'c']);
  assert.deepEqual(ordered.map((row) => row.relevanceRank), [2, 1, 3]);
});

test('no-match response uses the exact required wording and still returns closest records', () => {
  const response = buildSearchResponse([{ sourceId: 'x', similarity: 0.59 }], 0.60);
  assert.equal(response.strongMatch, false);
  assert.equal(response.message, NO_MATCH_MESSAGE);
  assert.equal(response.matches.length, 1);
  const strong = buildSearchResponse([{ sourceId: 'x', similarity: 0.60 }], 0.60);
  assert.equal(strong.strongMatch, true);
  assert.equal(Object.hasOwn(strong, 'message'), false);
});

test('clear-match status uses the best relevance score even when source order changes display order', () => {
  const response = buildSearchResponse([
    { sourceId: 'best', similarity: 0.61, sourceGroup: 'g', sourceOrder: 2 },
    { sourceId: 'first', similarity: 0.59, sourceGroup: 'g', sourceOrder: 1 },
  ], 0.60);
  assert.equal(response.matches[0].sourceId, 'first');
  assert.equal(response.strongMatch, true);
});

test('connection redaction does not expose secrets', () => {
  assert.deepEqual(redactConnection({ host: 'db', password: 'secret', connectionString: 'postgres://secret' }), {
    host: 'db', password: '[redacted]', connectionString: '[provided]',
  });
});
