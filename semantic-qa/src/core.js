const crypto = require('node:crypto');

const NO_MATCH_MESSAGE = 'I could not find a clear answer in the existing data.';
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function assertIdentifier(value, label = 'identifier') {
  const identifier = String(value || '');
  if (!IDENTIFIER_RE.test(identifier)) {
    const error = new Error(`${label} must be a standard PostgreSQL identifier`);
    error.code = 'INVALID_IDENTIFIER';
    throw error;
  }
  return identifier;
}

function quoteIdentifier(value, label) {
  return `"${assertIdentifier(value, label).replace(/"/g, '""')}"`;
}

function buildEmbeddingText(question, answer) {
  return `Question:\n${String(question)}\n\nAnswer:\n${String(answer)}`;
}

function contentHash(record) {
  const stable = {
    sourceId: String(record.sourceId),
    question: String(record.question),
    answer: String(record.answer),
    metadata: record.metadata || {},
    sourceGroup: record.sourceGroup ?? null,
    sourceOrder: record.sourceOrder ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function toVectorLiteral(values) {
  if (!Array.isArray(values) || !values.length || values.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error('Embedding provider returned an invalid vector');
  }
  return `[${values.map((value) => Number(value)).join(',')}]`;
}

function compareSourceOrder(a, b) {
  const av = a?.sourceOrder;
  const bv = b?.sourceOrder;
  if (av == null && bv == null) return a.relevanceRank - b.relevanceRank;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv || a.relevanceRank - b.relevanceRank;
  const ad = Date.parse(av);
  const bd = Date.parse(bv);
  if (Number.isFinite(ad) && Number.isFinite(bd)) return ad - bd || a.relevanceRank - b.relevanceRank;
  return String(av).localeCompare(String(bv), undefined, { numeric: true }) || a.relevanceRank - b.relevanceRank;
}

function orderMatches(rows) {
  const ranked = [...rows]
    .sort((a, b) => Number(b.similarity) - Number(a.similarity))
    .map((row, index) => ({ ...row, similarity: Number(row.similarity), relevanceRank: index + 1 }));
  const hasStructuredOrder = ranked.some((row) => row.sourceGroup != null && row.sourceOrder != null);
  if (!hasStructuredOrder) return ranked;

  const groups = new Map();
  for (const row of ranked) {
    const key = row.sourceGroup == null ? `__ungrouped_${row.relevanceRank}` : `group:${String(row.sourceGroup)}`;
    const group = groups.get(key) || { score: row.similarity, rows: [] };
    group.score = Math.max(group.score, row.similarity);
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.score - a.score)
    .flatMap((group) => group.rows.sort(compareSourceOrder));
}

function buildSearchResponse(rows, threshold) {
  const matches = orderMatches(rows);
  const bestSimilarity = matches.reduce((best, match) => Math.max(best, match.similarity), -Infinity);
  const strongMatch = matches.length > 0 && bestSimilarity >= Number(threshold);
  return {
    strongMatch,
    ...(strongMatch ? {} : { message: NO_MATCH_MESSAGE }),
    matches,
  };
}

function redactConnection(connection) {
  if (!connection || typeof connection !== 'object') return connection;
  return {
    ...connection,
    password: connection.password ? '[redacted]' : '',
    connectionString: connection.connectionString ? '[provided]' : '',
  };
}

module.exports = {
  NO_MATCH_MESSAGE,
  assertIdentifier,
  quoteIdentifier,
  buildEmbeddingText,
  contentHash,
  toVectorLiteral,
  orderMatches,
  buildSearchResponse,
  redactConnection,
};
