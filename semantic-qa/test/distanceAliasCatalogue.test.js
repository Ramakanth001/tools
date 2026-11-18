const assert = require('node:assert/strict');
const test = require('node:test');
const { attachAliasCatalogue, lookupAliasEvidence, orderedPairs } = require('../src/distanceAliasCatalogue');
const { domainConcepts, domainEvidence } = require('../src/distanceDomainPhrases');

const identity = { units: 2, unit_fingerprint: 'u', records: 2, record_fingerprint: 'r' };
const primary = { id: 'a', hash: 'a1', sourceGroup: 'a', answer: new Map([['salari', [4]]]), question: new Map() };
const secondary = { id: 'b', hash: 'b1', sourceGroup: 'b', answer: new Map(), question: new Map() };
const catalogue = {
  version: 1, corpus: identity, documents: [['a', 'a1'], ['b', 'b1']],
  links: { 0: [[1, 0.7]] },
  postings: { salari: [[0, 0.8], [1, 0.9]], increment: [[0, 0.7], [1, 0.9]] },
  phrases: { 'salari increment': [[0, 0.75], [1, 0.9]] },
};

test('a lexical alias can add a grounded candidate only where actual wording supports it', () => {
  const corpus = attachAliasCatalogue({ documents: new Map([['a', { ...primary }], ['b', { ...secondary }]]) }, catalogue, identity);
  const query = {
    totalWeight: 2, terms: [{ term: 'salari', weight: 1 }, { term: 'increment', weight: 1 }],
    roles: [], phrasePairs: ['salari increment'],
  };
  const hits = lookupAliasEvidence(corpus, [query]);
  assert.deepEqual(hits.supplemental, ['a']);
  assert.deepEqual(hits.hits.get('a'), [0.75, 0.4, 0, 0.75, 0.75]);
  assert.equal(hits.hits.has('b'), false);
});

test('a catalogue with stale text or a different corpus fails validation', () => {
  const corpus = { documents: new Map([['a', { ...primary, hash: 'changed' }], ['b', secondary]]) };
  assert.throws(() => attachAliasCatalogue(corpus, catalogue, identity), /Stale English answer unit/);
  assert.throws(() => attachAliasCatalogue(corpus, catalogue, { ...identity, unit_fingerprint: 'new' }), /different corpus/);
});

test('associated wording links omit donors in the same source group', () => {
  const corpus = attachAliasCatalogue({ documents: new Map([
    ['a', { ...primary }], ['b', { ...secondary, sourceGroup: 'a' }],
  ]) }, catalogue, identity);
  assert.deepEqual(corpus.documents.get('a').aliasQuestions, []);
});

test('lexical phrase keys retain order and omit widely separated terms', () => {
  const terms = new Map([['world', [10, 20]], ['right', [13]], ['famili', [21]], ['work', [31]]]);
  assert.deepEqual(orderedPairs(terms), ['world right', 'world famili']);
});

test('the catalogue connects transliterations and keeps distinct doctrinal concepts apart', () => {
  assert.deepEqual(domainEvidence(domainConcepts('worldly duties'), domainConcepts('This is Pravrutti.')), [1, 1]);
  assert.deepEqual(domainEvidence(domainConcepts('causal body'), domainConcepts('The great causal body is different.')), [0, 0]);
  assert.deepEqual(domainEvidence(domainConcepts('devotion'), domainConcepts('This is Nivrutti.')), [0, 0]);
});
