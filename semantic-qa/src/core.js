const crypto = require('node:crypto');

const NO_MATCH_MESSAGE = 'I could not find a clear answer in the existing data.';
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const LEGACY_EMBEDDING_FORMAT = 'legacy-v1';
const GENERIC_EMBEDDING_FORMAT = 'generic-qa-v1';
const EMBEDDINGGEMMA_FORMAT = 'embeddinggemma-asymmetric-v2';
const RETRIEVAL_SCHEMA_VERSION = 'hybrid-v2';

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'please', 'should', 'tell', 'that',
  'the', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

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

function embeddingFormatForModel(model) {
  return /(^|[/_-])embeddinggemma(?=[:/_-]|$)/i.test(String(model || ''))
    ? EMBEDDINGGEMMA_FORMAT
    : GENERIC_EMBEDDING_FORMAT;
}

function buildDocumentEmbeddingText(question, answer, { model, formatVersion } = {}) {
  const format = formatVersion || embeddingFormatForModel(model);
  if (format === EMBEDDINGGEMMA_FORMAT) {
    return `title: ${String(question)} | text: ${String(answer)}`;
  }
  return buildEmbeddingText(question, answer);
}

function buildQueryEmbeddingText(question, { model, formatVersion } = {}) {
  const format = formatVersion || embeddingFormatForModel(model);
  if (format === EMBEDDINGGEMMA_FORMAT) {
    return `task: question answering | query: ${String(question)}`;
  }
  return String(question);
}

function tokenizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function significantTokens(value) {
  return [...new Set(tokenizeSearchText(value).filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)))];
}

function buildLexicalQuery(question) {
  const tokens = significantTokens(question);
  return (tokens.length ? tokens : tokenizeSearchText(question)).join(' ');
}

function coverage(needles, haystack) {
  if (!needles.length) return 0;
  const values = new Set(tokenizeSearchText(haystack));
  return needles.filter((token) => values.has(token)).length / needles.length;
}

function questionIntent(value) {
  const first = tokenizeSearchText(value)[0];
  return ['who', 'where', 'when', 'why', 'how', 'what', 'which'].includes(first) ? first : null;
}

function intentSignals(query, row) {
  const intent = questionIntent(query);
  if (!intent) return { positive: 0, conflict: 0 };
  const titleIntent = questionIntent(row.question);
  const beginning = String(row.answer || '').slice(0, 1200).toLocaleLowerCase();
  const identityBeginning = beginning.slice(0, 500);
  let positive = titleIntent === intent ? 0.55 : 0;
  let conflict = titleIntent && titleIntent !== intent ? 1 : 0;

  if (intent === 'who') {
    if (/^\s*who\s+(?:is|was)\b|\b(?:brief\s+)?biograph(?:y|ical)\b|\bdivine life of\b|\bincarnated as\b|^\s*about (?:his|her holiness|shri|sri)\b/i.test(String(row.question || ''))) {
      positive += 0.55;
    }
    if (/\bmy name is\b|\blet me introduce (?:his holiness )?(?:shri|sri) datta swami(?:ji)?\b|\b(?:his holiness )?(?:shri|sri) datta swami(?:ji)?\b[^.]{0,300}\b(?:shortly called|also called|known as|was born|is a retired|is an? (?:author|teacher|professor|saint|founder)|author|professor|doctorate|incarnation)\b/i.test(identityBeginning)) {
      positive += 0.45;
    }
    if (positive === 0) conflict = Math.max(conflict, 0.75);
  }
  if (intent === 'where' && /\b(address|located|location|visit|meet|phone|contact|city|village|country)\b/i.test(beginning)) positive += 0.45;
  if (intent === 'when' && /\b(?:in|on|during|before|after)\s+(?:the\s+)?(?:year\s+)?\d{2,4}\b/i.test(beginning)) positive += 0.45;
  if (intent === 'how' && /\b(first|next|then|finally|method|process|steps?)\b/i.test(beginning)) positive += 0.35;
  if (titleIntent === 'where' && intent === 'who') conflict = 1;
  return { positive: Math.min(1, positive), conflict };
}

function chunkPositionPrior(row, titleCoverage, intentPositive) {
  const value = Number(row?.metadata?.chunk_index ?? row?.sourceOrder);
  if (!Number.isFinite(value) || value < 1 || (titleCoverage < 0.5 && intentPositive < 0.5)) return 0;
  return 1 / Math.sqrt(value);
}

function scoreCandidate(row, query) {
  const queryTokens = significantTokens(query);
  const dense = Math.max(0, Math.min(1, Number(row.similarity) || 0));
  const lexical = 1 - Math.exp(-6 * Math.max(0, Number(row.lexicalScore) || 0));
  const titleCoverage = coverage(queryTokens, row.question);
  const answerCoverage = coverage(queryTokens, row.answer);
  const contextCoverage = coverage(queryTokens, row?.metadata?.source_context || '');
  const intent = intentSignals(query, row);
  const position = chunkPositionPrior(row, titleCoverage, intent.positive);
  const chunkIndex = Number(row?.metadata?.chunk_index ?? row?.sourceOrder);
  const canonicalOpening = questionIntent(query) && questionIntent(query) === questionIntent(row.question) && chunkIndex === 1 ? 1 : 0;
  const queryKey = significantTokens(query).join(' ');
  const titleKey = significantTokens(row.question).join(' ');
  const exactTitle = Boolean(queryKey && queryKey === titleKey);
  const score = (
    0.46 * dense
    + 0.14 * lexical
    + 0.13 * titleCoverage
    + 0.07 * Math.max(answerCoverage, contextCoverage)
    + 0.10 * intent.positive
    + 0.10 * position
    + 0.10 * canonicalOpening
    + (exactTitle ? 0.08 : 0)
    - 0.14 * intent.conflict
  );
  return {
    ...row,
    similarity: Number(row.similarity),
    lexicalScore: Number(row.lexicalScore) || 0,
    relevanceScore: Math.max(0, Math.min(1, score)),
    rankingSignals: { titleCoverage, answerCoverage, contextCoverage, intent: intent.positive, position, canonicalOpening },
  };
}

function rerankMatches(rows, query, limit = 5) {
  const groups = new Map();
  for (const row of rows.map((candidate) => scoreCandidate(candidate, query))) {
    const key = row.sourceGroup == null ? `record:${row.sourceId}` : `group:${String(row.sourceGroup)}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { row, score: row.relevanceScore });
      continue;
    }
    group.score = Math.max(group.score, row.relevanceScore);
    const current = group.row;
    const canonicalPreferred = row.rankingSignals.canonicalOpening !== current.rankingSignals.canonicalOpening
      ? row.rankingSignals.canonicalOpening > current.rankingSignals.canonicalOpening
      : null;
    if (canonicalPreferred === true || (canonicalPreferred == null &&
        (row.relevanceScore > current.relevanceScore ||
         (row.relevanceScore === current.relevanceScore && row.similarity > current.similarity)))) {
      group.row = row;
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group.row, relevanceScore: group.score }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore || b.similarity - a.similarity || String(a.sourceId).localeCompare(String(b.sourceId)))
    .slice(0, Math.max(1, Number(limit) || 5));
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
    .sort((a, b) => Number(b.relevanceScore ?? b.similarity) - Number(a.relevanceScore ?? a.similarity))
    .map((row, index) => ({ ...row, similarity: Number(row.similarity), relevanceRank: index + 1 }));
  const hasStructuredOrder = ranked.some((row) => row.sourceGroup != null && row.sourceOrder != null);
  if (!hasStructuredOrder) return ranked;

  const groups = new Map();
  for (const row of ranked) {
    const key = row.sourceGroup == null ? `__ungrouped_${row.relevanceRank}` : `group:${String(row.sourceGroup)}`;
    const rowScore = Number(row.relevanceScore ?? row.similarity);
    const group = groups.get(key) || { score: rowScore, rows: [] };
    group.score = Math.max(group.score, rowScore);
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.score - a.score)
    .flatMap((group) => group.rows.sort(compareSourceOrder));
}

function buildSearchResponse(rows, threshold) {
  const matches = orderMatches(rows);
  const bestScore = matches.reduce((best, match) => Math.max(
    best,
    Number(match.relevanceScore ?? match.similarity),
    Number(match.similarity),
  ), -Infinity);
  const strongMatch = matches.length > 0 && bestScore >= Number(threshold);
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
  LEGACY_EMBEDDING_FORMAT,
  GENERIC_EMBEDDING_FORMAT,
  EMBEDDINGGEMMA_FORMAT,
  RETRIEVAL_SCHEMA_VERSION,
  assertIdentifier,
  quoteIdentifier,
  buildEmbeddingText,
  embeddingFormatForModel,
  buildDocumentEmbeddingText,
  buildQueryEmbeddingText,
  buildLexicalQuery,
  rerankMatches,
  scoreCandidate,
  contentHash,
  toVectorLiteral,
  orderMatches,
  buildSearchResponse,
  redactConnection,
};
