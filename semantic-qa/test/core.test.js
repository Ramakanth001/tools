const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EMBEDDINGGEMMA_FORMAT,
  GENERIC_EMBEDDING_FORMAT,
  NO_MATCH_MESSAGE,
  RETRIEVAL_SCHEMA_VERSION,
  assertIdentifier,
  buildDocumentEmbeddingText,
  buildEmbeddingText,
  buildLexicalQuery,
  buildPassageEmbeddingText,
  buildQueryEmbeddingText,
  contentHash,
  extractRequestedPhrases,
  buildSearchResponse,
  orderMatches,
  redactConnection,
  rerankMatches,
  rerankPassageMatches,
  rerankTextMatches,
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
  assert.equal(buildLexicalQuery('Who is Datta Swami?'), 'datta OR swami');
  assert.equal(
    buildPassageEmbeddingText('The light in Me signifies qualified monism.', { model: 'embeddinggemma' }),
    'title:  | text: The light in Me signifies qualified monism.',
  );
});

test('conventional search pools exact, full-text, and fuzzy passage ranks by source', () => {
  const matches = rerankTextMatches([
    { sourceId: 'a', sourceGroup: 'a', passageIndex: 0, passageText: 'Exact light phrase.', passageStart: 0, passageEnd: 19, searchScore: 0.9, lexicalScore: 0.3, trigramSimilarity: 0.8, matchChannels: ['exact passage'] },
    { sourceId: 'a', sourceGroup: 'a', passageIndex: 1, passageText: 'Supporting text.', passageStart: 20, passageEnd: 36, searchScore: 0.5, lexicalScore: 0.2, trigramSimilarity: 0.4, matchChannels: ['full text'] },
    { sourceId: 'b', sourceGroup: 'b', passageIndex: 0, passageText: 'Fuzzy result.', passageStart: 0, passageEnd: 13, searchScore: 0.6, lexicalScore: 0, trigramSimilarity: 0.7, matchChannels: ['fuzzy passage'] },
  ], 5);
  assert.equal(matches[0].sourceId, 'a');
  assert.equal(matches[0].matchedPassages.length, 2);
  assert.deepEqual(new Set(matches[0].matchChannels), new Set(['exact passage', 'full text']));
  assert.equal(matches[1].rankingSignals.semanticWeight, 0);
});

test('passage reranking accepts answer meaning without using the stored question or title', () => {
  const matches = rerankPassageMatches([
    {
      sourceId: 'correct',
      question: 'Is the resurrection of Jesus false?',
      answer: 'The Light is in Me indicates qualified monism.',
      passageIndex: 0,
      passageText: 'Jesus saying The Light is in Me indicates qualified monism.',
      passageStart: 0,
      passageEnd: 61,
      similarity: 0.48,
      lexicalScore: 0.2,
      metadata: {},
    },
    {
      sourceId: 'wrong-title',
      question: 'What is the meaning of a ray of light?',
      answer: 'A dream contained a ray of light.',
      passageIndex: 0,
      passageText: 'A dream contained a ray of light.',
      passageStart: 0,
      passageEnd: 33,
      similarity: 0.43,
      lexicalScore: 1,
      metadata: {},
    },
  ], 'What is the meaning of Jesus saying The light is in me?', 5);
  assert.equal(matches[0].sourceId, 'correct');
  assert.equal(matches[0].rankingSignals.lexicalWeight, 0);
  assert.equal(matches[0].rankingSignals.titleWeight, 0);
  assert.equal(matches[0].rankingSignals.questionWeight, 0);
  assert.equal(matches[0].matchedPassages[0].text, 'Jesus saying The Light is in Me indicates qualified monism.');
});

test('one independent semantic support passage can lift a borderline answer without lexical weight', () => {
  const matches = rerankPassageMatches([
    {
      sourceId: 'stages', passageIndex: 5,
      passageText: 'The Light is in Me means qualified monism between dualism and monism.',
      passageStart: 100, passageEnd: 175, similarity: 0.4767, lexicalScore: 1,
    },
    {
      sourceId: 'stages', passageIndex: 2,
      passageText: 'Jesus also described monism and dualism as distinct philosophical stages.',
      passageStart: 20, passageEnd: 92, similarity: 0.4354, lexicalScore: 0,
    },
  ], 'What does The Light is in Me mean?', 5);
  assert.ok(matches[0].relevanceScore >= 0.49);
  assert.equal(matches[0].rankingSignals.supportingPassages, 1);
  assert.equal(matches[0].rankingSignals.lexicalWeight, 0);
});

test('an exact structured Q&A discovery question returns its paired Swami answer first', () => {
  const matches = rerankPassageMatches([
    {
      sourceId: 'semantic-neighbor', question: 'A nearby discourse',
      passageIndex: 0, passageText: 'A strongly similar teaching about the exact “Lord help” phrase.',
      passageStart: 0, passageEnd: 28, similarity: 0.91,
      metadata: { source_type: 'discourse' },
    },
    {
      sourceId: 'paired-qa', question: 'Why is “Lord help” emphasized?',
      passageIndex: 0, passageText: 'Swami replied with the complete answer.',
      passageStart: 0, passageEnd: 39, similarity: 0.73,
      discoverySimilarity: 0.95, discoveryExact: true,
      metadata: { source_type: 'qa' },
    },
  ], 'Why is “Lord help” emphasized?', 5);
  assert.equal(matches[0].sourceId, 'paired-qa');
  assert.equal(matches[0].rankingSignals.exactQaDiscovery, true);
});

test('an explicit quoted phrase orders the matching semantic answer before a nearby rewording', () => {
  const matches = rerankPassageMatches([
    {
      sourceId: 'nearby', passageIndex: 0,
      passageText: 'Jesus said I am the Light, meaning complete monism.',
      passageStart: 0, passageEnd: 55, similarity: 0.64,
    },
    {
      sourceId: 'exact', passageIndex: 0,
      passageText: 'The Light is in Me means qualified monism.',
      passageStart: 0, passageEnd: 46, similarity: 0.54,
    },
  ], 'What does "The Light is in Me" mean?', 5);
  assert.equal(matches[0].sourceId, 'exact');
  assert.equal(matches[0].rankingSignals.lexicalWeight, 0);
  assert.equal(matches[0].rankingSignals.titleWeight, 0);
});

test('an unquoted saying clause is treated as a phrase identity constraint', () => {
  assert.deepEqual(
    extractRequestedPhrases('What is the meaning of Jesus saying The light is in me?'),
    ['the light is in me'],
  );
  const matches = rerankPassageMatches([
    { sourceId: 'nearby', passageIndex: 0, passageText: 'Jesus said I am the Light, meaning monism.', passageStart: 0, passageEnd: 43, similarity: 0.70 },
    { sourceId: 'exact', passageIndex: 0, passageText: 'The Light is in Me means qualified monism.', passageStart: 0, passageEnd: 43, similarity: 0.55 },
  ], 'What is the meaning of Jesus saying The light is in me?', 5);
  assert.equal(matches[0].sourceId, 'exact');
});

test('the final response order preserves an explicit quote identity constraint', () => {
  const response = buildSearchResponse([
    {
      sourceId: 'nearby', relevanceScore: 0.70, similarity: 0.70,
      matchedPassages: [{ text: 'I am the Light means monism.' }],
    },
    {
      sourceId: 'exact', relevanceScore: 0.55, similarity: 0.55,
      matchedPassages: [{ text: 'The Light is in Me means qualified monism.' }],
    },
  ], 0.49, 'What does "The Light is in Me" mean?');
  assert.equal(response.acceptedMatch.sourceId, 'exact');
  assert.equal(response.matches[0].relevanceRank, 1);
});

test('current embedding formats include distinct source context and retain the EmbeddingGemma prompts', () => {
  assert.equal(GENERIC_EMBEDDING_FORMAT, 'generic-qa-v3');
  assert.equal(EMBEDDINGGEMMA_FORMAT, 'embeddinggemma-asymmetric-v3');
  assert.equal(RETRIEVAL_SCHEMA_VERSION, 'answer-unit-v5');
  assert.equal(
    buildDocumentEmbeddingText('Who is Ada?', 'Ada was a mathematician.', {
      model: 'embeddinggemma',
      context: 'Notes from an archived biography.',
    }),
    'title: Who is Ada? | text: Ada was a mathematician.\n\nSource context:\nNotes from an archived biography.',
  );
  assert.equal(
    buildDocumentEmbeddingText('Who is Ada?', 'Ada was a mathematician.', {
      model: 'embeddinggemma',
      context: '  Ada was a mathematician.  ',
    }),
    'title: Who is Ada? | text: Ada was a mathematician.',
  );
  assert.equal(
    buildQueryEmbeddingText('Who is Ada?', { formatVersion: 'embeddinggemma-asymmetric-v2' }),
    'task: question answering | query: Who is Ada?',
  );
});

test('lexical queries use broad OR semantics and contain only normalized search tokens', () => {
  assert.equal(
    buildLexicalQuery('Alpha + beta; "gamma" OR (DROP TABLE records)'),
    'alpha OR beta OR gamma OR drop OR table OR records',
  );
  assert.equal(buildLexicalQuery('THE the'), 'the');
  assert.equal(buildLexicalQuery(''), '');
});

test('hybrid reranking respects question intent, chooses the answering sibling, and deduplicates document chunks', () => {
  const rows = [
    {
      sourceId: 'where', question: 'Where can I meet Ada Lovelace?', answer: 'Call this phone number.',
      similarity: 0.71, lexicalScore: 0.2, sourceGroup: 'where', metadata: { chunk_index: 1 },
    },
    {
      sourceId: 'who:009', question: 'WHO IS ADA LOVELACE?', answer: 'This passage concerns her associates.',
      similarity: 0.70, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 9, chunk_count: 9 },
    },
    {
      sourceId: 'who:001', question: 'WHO IS ADA LOVELACE?', answer: 'Ada Lovelace was a mathematician.',
      similarity: 0.62, lexicalScore: 0.2, sourceGroup: 'who', metadata: { chunk_index: 1, chunk_count: 9 },
    },
  ];
  const matches = rerankMatches(rows, 'Who is Ada Lovelace?', 5);
  assert.equal(matches[0].sourceId, 'who:001');
  assert.equal(matches.filter((row) => row.sourceGroup === 'who').length, 1);
  assert.ok(matches[0].relevanceScore > matches[1].relevanceScore);
});

test('document chunk deduplication returns the genuinely highest-scoring passage without score laundering', () => {
  const query = 'What is orbital mechanics?';
  const high = {
    sourceId: 'doc:002',
    question: query,
    answer: 'Orbital mechanics describes the motion of spacecraft.',
    similarity: 0.99,
    lexicalScore: 0.3,
    sourceGroup: 'doc',
    sourceOrder: 2,
    metadata: { chunk_index: 2, chunk_count: 2 },
  };
  const lowOpening = {
    sourceId: 'doc:001',
    question: query,
    answer: 'An unrelated preface.',
    similarity: 0.01,
    lexicalScore: 0,
    sourceGroup: 'doc',
    sourceOrder: 1,
    metadata: { chunk_index: 1, chunk_count: 2 },
  };
  const expectedScore = rerankMatches([{ ...high, sourceGroup: null }], query, 1)[0].relevanceScore;
  const matches = rerankMatches([lowOpening, high], query, 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sourceId, 'doc:002');
  assert.equal(matches[0].relevanceScore, expectedScore);
});

test('source groups used as categories are not deduplicated without explicit multi-chunk metadata', () => {
  const matches = rerankMatches([
    {
      sourceId: 'faq:a', question: 'How do I reset a password?', answer: 'Use the reset link.',
      similarity: 0.9, lexicalScore: 0.2, sourceGroup: 'account', sourceOrder: 20, metadata: { chunk_count: 1 },
    },
    {
      sourceId: 'faq:b', question: 'How do I change an email?', answer: 'Open account settings.',
      similarity: 0.8, lexicalScore: 0.1, sourceGroup: 'account', sourceOrder: 10, metadata: {},
    },
  ], 'How do I update my account?', 5);
  assert.deepEqual(matches.map((row) => row.sourceId).sort(), ['faq:a', 'faq:b']);
});

test('a stored detailed question and structured QA prior can outrank a noisier discourse hit', () => {
  const query = 'How should I handle anxiety about having a child?';
  const matches = rerankMatches([
    {
      sourceId: 'qa:208',
      question: 'What should I do about my anxiety to get a child?',
      answer: 'Put forth effort without becoming anxious about the result.',
      similarity: 0.42,
      lexicalScore: 0.2,
      sourceGroup: 'qa:208',
      metadata: { source_type: 'qa', source_context: query, chunk_count: 1 },
    },
    {
      sourceId: 'discourse:other',
      question: 'How should parents deal with children?',
      answer: 'A general discussion of parenting.',
      similarity: 0.55,
      lexicalScore: 0.2,
      sourceGroup: 'discourse:other',
      metadata: { source_type: 'discourse', chunk_count: 1 },
    },
  ], query, 5);
  assert.equal(matches[0].sourceId, 'qa:208');
  assert.equal(matches[0].rankingSignals.exactContext, true);
  assert.equal(matches[0].rankingSignals.structuredQa, 1);
});

test('decision intent aligns should, can, do, and is questions without requiring exact wording', () => {
  const matches = rerankMatches([
    {
      sourceId: 'oil-lamp',
      question: 'Should all people light an electric lamp before an idol of God instead of an oil lamp?',
      answer: 'Neither an electric lamp nor an oil lamp is needed for God. What is the use of the oil lamp when electric light already exists?',
      similarity: 0.4597674882,
      lexicalScore: 6.5,
      metadata: { source_type: 'discourse', chunk_count: 1 },
    },
    {
      sourceId: 'lamp-analogy',
      question: 'What does a lamp symbolize?',
      answer: 'The lamp is used as an analogy in this passage.',
      similarity: 0.50,
      lexicalScore: 2,
      metadata: { source_type: 'discourse', chunk_count: 1 },
    },
  ], 'should we use oil based lamp?', 5);
  assert.equal(matches[0].sourceId, 'oil-lamp');
  assert.ok(matches[0].rankingSignals.intent > 0);
  assert.ok(matches[0].relevanceScore >= 0.49);
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

test('matches are displayed by relevance even when a shared source group has a different source order', () => {
  const ordered = orderMatches([
    { sourceId: 'b', similarity: 0.91, sourceGroup: 'chapter', sourceOrder: 2 },
    { sourceId: 'a', similarity: 0.90, sourceGroup: 'chapter', sourceOrder: 1 },
    { sourceId: 'c', similarity: 0.80, sourceGroup: 'other', sourceOrder: 1 },
  ]);
  assert.deepEqual(ordered.map((row) => row.sourceId), ['b', 'a', 'c']);
  assert.deepEqual(ordered.map((row) => row.relevanceRank), [1, 2, 3]);
});

test('no-match response uses the exact required wording and still returns closest records', () => {
  const response = buildSearchResponse([{ sourceId: 'x', similarity: 0.59 }], 0.60);
  assert.equal(response.strongMatch, false);
  assert.equal(response.message, NO_MATCH_MESSAGE);
  assert.equal(response.matches.length, 1);
  assert.equal(Object.hasOwn(response, 'acceptedMatch'), false);
  const strong = buildSearchResponse([{ sourceId: 'x', similarity: 0.60 }], 0.60);
  assert.equal(strong.strongMatch, true);
  assert.equal(Object.hasOwn(strong, 'message'), false);
  assert.equal(strong.acceptedMatch.sourceId, 'x');
});

test('clear-match threshold uses only the top result final ranking score', () => {
  const weak = buildSearchResponse([
    { sourceId: 'misleading-dense', similarity: 0.99, relevanceScore: 0.59 },
  ], 0.60);
  assert.equal(weak.strongMatch, false);
  assert.equal(Object.hasOwn(weak, 'acceptedMatch'), false);

  const response = buildSearchResponse([
    { sourceId: 'best-final', similarity: 0.61, relevanceScore: 0.72, sourceGroup: 'g', sourceOrder: 2 },
    { sourceId: 'best-dense', similarity: 0.99, relevanceScore: 0.68, sourceGroup: 'g', sourceOrder: 1 },
  ], 0.70);
  assert.equal(response.matches[0].sourceId, 'best-final');
  assert.equal(response.strongMatch, true);
  assert.equal(response.acceptedMatch.sourceId, 'best-final');
});

test('connection redaction does not expose secrets', () => {
  assert.deepEqual(redactConnection({ host: 'db', password: 'secret', connectionString: 'postgres://secret' }), {
    host: 'db', password: '[redacted]', connectionString: '[provided]',
  });
});
