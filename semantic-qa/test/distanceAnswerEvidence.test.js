const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FEATURES, buildAnswerFeatures, buildEvidenceQuery, createEvidenceCorpus, forwardDistance, retrieveAnswerEvidence, windowCoverage,
} = require('../src/distanceAnswerEvidence');
const { buildLexicalAssociations } = require('../src/distanceLexicalAssociations');
const { buildPhraseLinks } = require('../src/distancePhraseLinks');

test('phrase proximity preserves direction and excludes same-token matches', () => {
  assert.equal(forwardDistance([2, 4], [4, 11], 12), 2);
  assert.equal(forwardDistance([12], [12], 12), 13);
  assert.equal(forwardDistance([12], [4], 12), 13);
});

test('an answer marker only supports a nearby window with two distinct concepts', () => {
  const hits = [{ position: 4, term: 0 }, { position: 9, term: 0 }, { position: 15, term: 1 }];
  assert.deepEqual(windowCoverage(hits, [2, 3], 22, [13]), { coverage: 5, aligned: 5 });
  assert.deepEqual(windowCoverage(hits, [2, 3], 22, [80]), { coverage: 5, aligned: 0 });
  assert.deepEqual(windowCoverage(hits.slice(0, 2), [2, 3], 22, [8]), { coverage: 0, aligned: 0 });
});

test('a comparison gets stronger field evidence when the answer covers both sides nearby', () => {
  const rows = [
    { answer_unit_id: 'both', answer_text: 'Giving freely is love whereas giving for a reward is trade.',
      answer_vector: "'give':1,6 'freeli':2 'reward':9 'love':4 'trade':11" },
    { answer_unit_id: 'one', answer_text: 'Giving is done for a reward.',
      answer_vector: "'give':1 'reward':6" },
    ...Array.from({ length: 5 }, (_, i) => ({ answer_unit_id: 'other' + i, answer_text: 'Another topic',
      answer_vector: "'topic':2" })),
  ];
  const corpus = createEvidenceCorpus(rows, { links: false, associations: false });
  const evidence = buildEvidenceQuery('How does giving freely differ from giving for a reward?',
    "'give':3,7 'freeli':4 'reward':10", ["'give':1 'freeli':2", "'give':1 'reward':4"], corpus);
  const features = id => buildAnswerFeatures({}, 0, evidence, corpus.documents.get(id));
  assert.equal(features('both').length, FEATURES.length);
  assert.equal(features('both')[FEATURES.indexOf('answer.roleWindow')], 1);
  assert.equal(features('one')[FEATURES.indexOf('answer.roleWindow')], 0);
  assert.equal(features('both')[FEATURES.indexOf('answer.pivotRoleCoverage')], 1);
  assert.equal(features('both')[FEATURES.indexOf('answer.reversePivotRoleCoverage')], 0);
  assert.ok(retrieveAnswerEvidence(corpus, [evidence]).supplemental.includes('both'));
});

test('corpus association support is counted across different sources', () => {
  const document = (sourceId, asked, answered) => ({ sourceId, questionText: 'Question?',
    question: new Map(asked.map(word => [word, [1]])), answer: new Map(answered.map(word => [word, [1]])) });
  const documents = new Map(Array.from({ length: 25 }, (_, index) => [String(index), document(
    'source' + index, index < 5 ? ['wage'] : ['another'], index < 5 ? ['increment'] : ['other'],
  )]));
  assert.equal(buildLexicalAssociations(documents).get('wage')[0].term, 'increment');
  for (let i = 0; i < 5; i++) documents.get(String(i)).sourceId = 'only-one-source';
  assert.equal(buildLexicalAssociations(documents).has('wage'), false);
});

test('phrase links require distinctive repeated lexical phrases and a different source', () => {
  const terms = 'teacher answers openly parents compare kindness patience action'.split(' ');
  const make = (sourceId, words) => ({ sourceId, questionText: 'What is the point?',
    answer: new Map(words.map((word, i) => [word, [i + 1]])) });
  const first = make('a', terms);
  const second = make('b', terms);
  const unrelated = make('c', 'question says otherwise entirely'.split(' '));
  const docs = new Map([['a', first], ['b', second], ['c', unrelated]]);
  const frequencies = new Map(terms.map(word => [word, 2]));
  assert.deepEqual(buildPhraseLinks(docs, frequencies).get(first).map(link => link.document.sourceId), ['b']);
  second.sourceId = 'a';
  assert.equal(buildPhraseLinks(docs, frequencies).has(first), false);
});
