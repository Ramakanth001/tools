const crypto = require('node:crypto');

const NO_MATCH_MESSAGE = 'I could not find a clear answer in the existing data.';
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const LEGACY_EMBEDDING_FORMAT = 'legacy-v1';
const GENERIC_EMBEDDING_FORMAT = 'generic-qa-v3';
const EMBEDDINGGEMMA_FORMAT = 'embeddinggemma-asymmetric-v3';
const LEGACY_EMBEDDINGGEMMA_FORMAT = 'embeddinggemma-asymmetric-v2';
const RETRIEVAL_SCHEMA_VERSION = 'passage-v4';

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'please', 'should', 'tell', 'that',
  'the', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with',
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

function normalizedComparableText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function answerWithContext(answer, context) {
  const answerText = String(answer);
  const contextText = String(context || '').trim();
  if (!contextText || normalizedComparableText(contextText) === normalizedComparableText(answerText)) {
    return answerText;
  }
  return `${answerText}\n\nSource context:\n${contextText}`;
}

function isEmbeddingGemmaFormat(format) {
  return format === EMBEDDINGGEMMA_FORMAT || format === LEGACY_EMBEDDINGGEMMA_FORMAT;
}

function buildDocumentEmbeddingText(question, answer, { model, formatVersion, context } = {}) {
  const format = formatVersion || embeddingFormatForModel(model);
  const documentText = (
    format === GENERIC_EMBEDDING_FORMAT || format === EMBEDDINGGEMMA_FORMAT
      ? answerWithContext(answer, context)
      : String(answer)
  );
  if (isEmbeddingGemmaFormat(format)) {
    return `title: ${String(question)} | text: ${documentText}`;
  }
  return buildEmbeddingText(question, documentText);
}

function buildPassageEmbeddingText(passage, { model, formatVersion } = {}) {
  return buildDocumentEmbeddingText('', passage, { model, formatVersion });
}

function buildQueryEmbeddingText(question, { model, formatVersion } = {}) {
  const format = formatVersion || embeddingFormatForModel(model);
  if (isEmbeddingGemmaFormat(format)) {
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

function quotedPhrases(value) {
  const phrases = [];
  const expression = /"([^"\n]{3,})"|“([^”\n]{3,})”|'([^'\n]{3,})'|‘([^’\n]{3,})’/gu;
  for (const match of String(value || '').matchAll(expression)) {
    const phrase = normalizedComparableText(match.slice(1).find(Boolean)).toLocaleLowerCase();
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

function passageMatchesQuotedPhrases(row, phrases) {
  if (!phrases.length) return false;
  return (Array.isArray(row.matchedPassages) ? row.matchedPassages : [])
    .some((passage) => {
      const text = normalizedComparableText(passage.text).toLocaleLowerCase();
      return phrases.every((phrase) => text.includes(phrase));
    });
}

function buildLexicalQuery(question) {
  const tokens = significantTokens(question);
  return (tokens.length ? tokens : [...new Set(tokenizeSearchText(question))]).join(' OR ');
}

function coverage(needles, haystack) {
  if (!needles.length) return 0;
  const values = new Set(tokenizeSearchText(haystack));
  return needles.filter((token) => values.has(token)).length / needles.length;
}

function questionIntent(value) {
  const first = tokenizeSearchText(value)[0];
  if (['who', 'where', 'when', 'why', 'how', 'what', 'which'].includes(first)) return first;
  if (['should', 'can', 'could', 'do', 'does', 'did', 'is', 'are', 'was', 'were', 'will', 'would', 'may', 'must'].includes(first)) {
    return 'decision';
  }
  return null;
}

function intentSignals(query, row) {
  const intent = questionIntent(query);
  if (!intent) return { positive: 0, conflict: 0 };
  const titleIntent = questionIntent(row.question);
  const beginning = String(row.answer || '').slice(0, 1200).toLocaleLowerCase();
  const identityBeginning = beginning.slice(0, 500);
  let positive = titleIntent === intent ? 0.55 : 0;

  if (intent === 'who') {
    if (/^\s*who\s+(?:is|was)\b|\b(?:brief\s+)?biograph(?:y|ical)\b/i.test(String(row.question || ''))) {
      positive += 0.55;
    }
    if (/^\s*(?:my name is|this is)\b|\b(?:is|was) (?:also )?known as\b|\b(?:was born|is an? (?:author|teacher|professor|founder))\b/i.test(identityBeginning)) {
      positive += 0.45;
    }
  }
  if (intent === 'where' && /\b(address|located|location|visit|meet|phone|contact|city|village|country)\b/i.test(beginning)) positive += 0.45;
  if (intent === 'when' && /\b(?:in|on|during|before|after)\s+(?:the\s+)?(?:year\s+)?\d{2,4}\b/i.test(beginning)) positive += 0.45;
  if (intent === 'how' && /\b(first|next|then|finally|method|process|steps?)\b/i.test(beginning)) positive += 0.35;
  return { positive: Math.min(1, positive), conflict: 0 };
}

function chunkPositionPrior(row, titleCoverage, intentPositive) {
  if (!(Number(row?.metadata?.chunk_count) > 1)) return 0;
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
  const queryKey = significantTokens(query).join(' ');
  const titleKey = significantTokens(row.question).join(' ');
  const contextKey = significantTokens(row?.metadata?.source_context || '').join(' ');
  const exactTitle = Boolean(queryKey && queryKey === titleKey);
  const exactContext = Boolean(queryKey && queryKey === contextKey);
  const structuredQa = row?.metadata?.source_type === 'qa' ? 1 : 0;
  const score = (
    0.46 * dense
    + 0.14 * lexical
    + 0.13 * titleCoverage
    + 0.07 * Math.max(answerCoverage, contextCoverage)
    + 0.10 * intent.positive
    + (exactTitle ? 0.08 : 0)
    + (exactContext ? 0.10 : 0)
    + 0.05 * structuredQa
  );
  return {
    ...row,
    similarity: Number(row.similarity),
    lexicalScore: Number(row.lexicalScore) || 0,
    relevanceScore: Math.max(0, Math.min(1, score)),
    rankingSignals: {
      titleCoverage,
      answerCoverage,
      contextCoverage,
      intent: intent.positive,
      position,
      exactContext,
      structuredQa,
    },
  };
}

function isDocumentChunk(row) {
  return row.sourceGroup != null && Number(row?.metadata?.chunk_count) > 1;
}

function rerankMatches(rows, query, limit = 5) {
  const groups = new Map();
  for (const row of rows.map((candidate) => scoreCandidate(candidate, query))) {
    const key = isDocumentChunk(row)
      ? `document:${String(row.sourceGroup)}`
      : `record:${String(row.sourceId)}`;
    const current = groups.get(key);
    if (!current ||
        row.relevanceScore > current.relevanceScore ||
        (row.relevanceScore === current.relevanceScore && row.similarity > current.similarity)) {
      groups.set(key, row);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.relevanceScore - a.relevanceScore || b.similarity - a.similarity || String(a.sourceId).localeCompare(String(b.sourceId)))
    .slice(0, Math.max(1, Number(limit) || 5));
}

function rerankPassageMatches(rows, query, limit = 5) {
  const records = new Map();
  for (const row of rows) {
    const key = String(row.sourceId);
    if (!records.has(key)) records.set(key, []);
    records.get(key).push(row);
  }

  const rankedRecords = [];
  for (const sourceRows of records.values()) {
    const passages = sourceRows
      .map((row) => ({
        sourceId: row.sourceId,
        passageIndex: Number(row.passageIndex),
        text: row.passageText,
        start: Number(row.passageStart),
        end: Number(row.passageEnd),
        semanticSimilarity: Math.max(0, Math.min(1, Number(row.similarity) || 0)),
        lexicalScore: Number(row.lexicalScore) || 0,
      }))
      .sort((left, right) => (
        right.semanticSimilarity - left.semanticSimilarity ||
        right.lexicalScore - left.lexicalScore ||
        left.passageIndex - right.passageIndex
      ));
    if (!passages.length) continue;

    const best = passages[0];
    const supportingPassages = passages.filter((passage, index) => (
      index > 0 && passage.semanticSimilarity >= Math.max(0.35, best.semanticSimilarity - 0.12)
    )).length;
    // Passage meaning is the acceptance signal. Independent semantic support can
    // only add a small bonus; word overlap and stored titles add nothing.
    const relevanceScore = Math.min(
      1,
      best.semanticSimilarity + Math.min(0.03, supportingPassages * 0.015),
    );
    const representative = sourceRows.find((row) => Number(row.passageIndex) === best.passageIndex) || sourceRows[0];
    rankedRecords.push({
      ...representative,
      similarity: best.semanticSimilarity,
      lexicalScore: best.lexicalScore,
      relevanceScore,
      matchedPassages: passages.slice(0, 5),
      rankingSignals: {
        supportingPassages,
        lexicalWeight: 0,
        titleWeight: 0,
        questionWeight: 0,
      },
    });
  }

  const groups = new Map();
  for (const row of rankedRecords) {
    const key = isDocumentChunk(row)
      ? `document:${String(row.sourceGroup)}`
      : `record:${String(row.sourceId)}`;
    const current = groups.get(key);
    if (!current ||
        row.relevanceScore > current.relevanceScore ||
        (row.relevanceScore === current.relevanceScore && row.similarity > current.similarity)) {
      groups.set(key, row);
    }
  }
  const sorted = [...groups.values()]
    .sort((left, right) => (
      right.relevanceScore - left.relevanceScore ||
      right.similarity - left.similarity ||
      String(left.sourceId).localeCompare(String(right.sourceId))
    ));
  const phrases = quotedPhrases(query);
  if (phrases.length && sorted.some((row) => passageMatchesQuotedPhrases(row, phrases))) {
    sorted.sort((left, right) => (
      Number(passageMatchesQuotedPhrases(right, phrases)) - Number(passageMatchesQuotedPhrases(left, phrases)) ||
      right.relevanceScore - left.relevanceScore ||
      right.similarity - left.similarity ||
      String(left.sourceId).localeCompare(String(right.sourceId))
    ));
  }
  return sorted.slice(0, Math.max(1, Number(limit) || 5));
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

function orderMatches(rows, query = '') {
  const phrases = quotedPhrases(query);
  const hasQuotedMatch = phrases.length && rows.some((row) => passageMatchesQuotedPhrases(row, phrases));
  return [...rows]
    .sort((a, b) => (
      (hasQuotedMatch
        ? Number(passageMatchesQuotedPhrases(b, phrases)) - Number(passageMatchesQuotedPhrases(a, phrases))
        : 0) ||
      Number(b.relevanceScore ?? b.similarity) - Number(a.relevanceScore ?? a.similarity) ||
      Number(b.similarity) - Number(a.similarity) ||
      String(a.sourceId).localeCompare(String(b.sourceId))
    ))
    .map((row, index) => ({ ...row, similarity: Number(row.similarity), relevanceRank: index + 1 }));
}

function buildSearchResponse(rows, threshold, query = '') {
  const matches = orderMatches(rows, query);
  const topScore = matches.length ? Number(matches[0].relevanceScore ?? matches[0].similarity) : -Infinity;
  const strongMatch = Number.isFinite(topScore) && topScore >= Number(threshold);
  return {
    strongMatch,
    ...(strongMatch ? {} : { message: NO_MATCH_MESSAGE }),
    ...(strongMatch ? { acceptedMatch: matches[0] } : {}),
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
  buildPassageEmbeddingText,
  buildQueryEmbeddingText,
  buildLexicalQuery,
  rerankMatches,
  rerankPassageMatches,
  scoreCandidate,
  contentHash,
  toVectorLiteral,
  orderMatches,
  buildSearchResponse,
  redactConnection,
};
