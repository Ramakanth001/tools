const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVector, clusterTopics, requestedTopicCount, isFrequentTopicsRequest } = require('../src/topicAnalysis');

test('frequent-topic requests are routed to corpus-wide analysis', () => {
  assert.equal(isFrequentTopicsRequest('just show 20 most frequently repeated topics in corpus'), true);
  assert.equal(isFrequentTopicsRequest('what does the corpus say about devotion?'), false);
  assert.equal(requestedTopicCount('show the top 75 recurring corpus themes'), 50);
  assert.equal(requestedTopicCount('show recurring corpus themes'), 20);
});

test('topic vectors are projected and normalized deterministically', () => {
  const vector = parseVector('[3,4,0,0]', 2);
  assert.equal(vector.length, 2);
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.00001);
});

test('semantic topic clustering counts every corpus document exactly once', () => {
  const rows = [
    { sourceId: 'a1', title: 'Devotion to God', embedding: '[1,0]' },
    { sourceId: 'a2', title: 'Pure devotion', embedding: '[0.98,0.02]' },
    { sourceId: 'a3', title: 'Prayer and devotion', embedding: '[0.95,0.05]' },
    { sourceId: 'b1', title: 'Nature of the world', embedding: '[0,1]' },
    { sourceId: 'b2', title: 'Creation and the world', embedding: '[0.03,0.97]' },
  ];
  const clusters = clusterTopics(rows, 2, { dimensions: 2, iterations: 4 });
  assert.equal(clusters.length, 2);
  assert.equal(clusters.reduce((sum, cluster) => sum + cluster.count, 0), rows.length);
  assert.deepEqual(clusters.map((cluster) => cluster.count).sort((a, b) => b - a), [3, 2]);
  assert.equal(clusters[0].representatives.length > 0, true);
});
