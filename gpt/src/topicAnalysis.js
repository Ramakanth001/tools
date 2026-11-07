function parseVector(value, targetDimensions = 96) {
  const parts = String(value || '').replace(/^\[|\]$/gu, '').split(',');
  if (!parts.length || parts.some((part) => !Number.isFinite(Number(part)))) return null;
  const width = Math.max(1, Math.min(parts.length, Number(targetDimensions) || 96));
  const vector = new Float32Array(width);
  let norm = 0;
  for (let index = 0; index < width; index += 1) {
    const sourceIndex = Math.min(parts.length - 1, Math.floor(index * parts.length / width));
    const number = Number(parts[sourceIndex]);
    vector[index] = number;
    norm += number * number;
  }
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

function dot(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function normalized(values) {
  let norm = 0;
  for (let index = 0; index < values.length; index += 1) norm += values[index] * values[index];
  norm = Math.sqrt(norm) || 1;
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) result[index] = values[index] / norm;
  return result;
}

function initializeCentroids(documents, count) {
  const centroids = [documents[0].vector];
  const nearest = new Float32Array(documents.length).fill(-Infinity);
  while (centroids.length < count) {
    const newest = centroids[centroids.length - 1];
    let nextIndex = 0;
    let lowestSimilarity = Infinity;
    for (let index = 0; index < documents.length; index += 1) {
      nearest[index] = Math.max(nearest[index], dot(documents[index].vector, newest));
      if (nearest[index] < lowestSimilarity) {
        lowestSimilarity = nearest[index];
        nextIndex = index;
      }
    }
    centroids.push(documents[nextIndex].vector);
  }
  return centroids;
}

function assign(documents, centroids) {
  const assignments = new Int32Array(documents.length);
  for (let docIndex = 0; docIndex < documents.length; docIndex += 1) {
    let bestCluster = 0;
    let bestScore = -Infinity;
    for (let clusterIndex = 0; clusterIndex < centroids.length; clusterIndex += 1) {
      const score = dot(documents[docIndex].vector, centroids[clusterIndex]);
      if (score > bestScore) { bestScore = score; bestCluster = clusterIndex; }
    }
    assignments[docIndex] = bestCluster;
  }
  return assignments;
}

function recalculate(documents, assignments, count, previous) {
  const sums = Array.from({ length: count }, () => new Float64Array(documents[0].vector.length));
  const sizes = new Uint32Array(count);
  for (let docIndex = 0; docIndex < documents.length; docIndex += 1) {
    const cluster = assignments[docIndex];
    sizes[cluster] += 1;
    const vector = documents[docIndex].vector;
    for (let dimension = 0; dimension < vector.length; dimension += 1) sums[cluster][dimension] += vector[dimension];
  }
  return sums.map((sum, index) => sizes[index] ? normalized(sum) : previous[index]);
}

function clusterTopics(rows, requestedCount = 20, { dimensions = 96, iterations = 5 } = {}) {
  const documents = (rows || []).map((row) => ({ ...row, vector: parseVector(row.embedding, dimensions) }))
    .filter((row) => row.vector && String(row.title || '').trim());
  if (!documents.length) return [];
  const count = Math.max(1, Math.min(Number(requestedCount) || 20, 50, documents.length));
  let centroids = initializeCentroids(documents, count);
  let assignments;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    assignments = assign(documents, centroids);
    centroids = recalculate(documents, assignments, count, centroids);
  }
  assignments = assign(documents, centroids);
  const clusters = Array.from({ length: count }, (_, clusterIndex) => ({ clusterIndex, documents: [] }));
  documents.forEach((document, index) => clusters[assignments[index]].documents.push(document));
  return clusters.filter((cluster) => cluster.documents.length).map((cluster) => {
    const representatives = [...cluster.documents]
      .map((document) => ({ ...document, centroidSimilarity: dot(document.vector, centroids[cluster.clusterIndex]) }))
      .sort((left, right) => right.centroidSimilarity - left.centroidSimilarity || String(left.sourceId).localeCompare(String(right.sourceId)))
      .slice(0, 5);
    return { clusterIndex: cluster.clusterIndex, count: cluster.documents.length, representatives };
  }).sort((left, right) => right.count - left.count || left.clusterIndex - right.clusterIndex)
    .map((cluster, rank) => ({ ...cluster, rank: rank + 1 }));
}

function requestedTopicCount(value, fallback = 20) {
  const match = String(value || '').match(/\b(\d{1,2})\b/u);
  return Math.max(1, Math.min(50, match ? Number(match[1]) : fallback));
}

function isFrequentTopicsRequest(value) {
  const text = String(value || '');
  return /\b(topic|topics|theme|themes|subject|subjects)\b/iu.test(text) &&
    /\b(frequent|frequently|common|repeated|recurring|popular|top|most)\b/iu.test(text) &&
    /\b(corpus|collection|data|documents?|records?)\b/iu.test(text);
}

module.exports = { parseVector, clusterTopics, requestedTopicCount, isFrequentTopicsRequest };
