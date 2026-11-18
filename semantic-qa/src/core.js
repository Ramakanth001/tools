const crypto = require('node:crypto');
const { getCanonicalSpiritualTerm, getSpiritualVariants, findMultiWordSpiritualTerms } = require('./spiritualEquivalents');
const { foldDiacritics } = require('./distanceSearch');
const { isCitableSwamiUnit } = require('./corpusStructure');

const NO_MATCH_MESSAGE = 'I could not find a clear answer in the existing data.';
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const LEGACY_EMBEDDING_FORMAT = 'legacy-v1';
const GENERIC_EMBEDDING_FORMAT = 'generic-contextual-v4';
const EMBEDDINGGEMMA_FORMAT = 'embeddinggemma-asymmetric-v4';
const LEGACY_EMBEDDINGGEMMA_FORMAT = 'embeddinggemma-asymmetric-v2';
const RETRIEVAL_SCHEMA_VERSION = 'answer-unit-v7';

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'should', 'tell', 'that',
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

function buildPassageEmbeddingText(passage, { model, formatVersion, title = '', associatedQuestion = '' } = {}) {
  const format = formatVersion || embeddingFormatForModel(model);
  const text = typeof passage === 'object' && passage !== null ? String(passage.text || '') : String(passage || '');
  const docTitle = String(title || (typeof passage === 'object' && (passage.title || passage.docTitle)) || '').trim();
  const rawQ = String(associatedQuestion || (typeof passage === 'object' && passage.associatedQuestion) || '').trim();
  const question = rawQ.length > 350 ? rawQ.slice(0, 350) + '...' : rawQ;

  if (isEmbeddingGemmaFormat(format)) {
    const contextPart = question ? ` (Question: ${question})` : '';
    const titlePart = docTitle ? `${docTitle}${contextPart}` : (question ? `Question: ${question}` : '');
    return titlePart ? `title: ${titlePart} | text: ${text}` : `title:  | text: ${text}`;
  }

  // Generic / BGE-M3 format: No empty Question: Answer: header! Inject title — associatedQuestion
  const header = [docTitle, question].filter(Boolean).join(' — ');
  return header ? `${header}\n\n${text}` : text;
}

function buildQueryEmbeddingText(question, { model, formatVersion } = {}) {
  const format = formatVersion || embeddingFormatForModel(model);
  const cleanQ = foldDiacritics(String(question || ''));
  if (isEmbeddingGemmaFormat(format)) {
    return `task: question answering | query: ${cleanQ}`;
  }
  return cleanQ;
}

function tokenizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || [];
}

function significantTokens(value) {
  return [...new Set(tokenizeSearchText(value).filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)))];
}

function quotedPhrases(value) {
  const phrases = [];
  const add = (candidate, minimumWords = 1) => {
    const phrase = normalizedComparableText(candidate)
      .replace(/^[\s"'‘’“”:,-]+|[\s"'‘’“”?.!,;:-]+$/gu, '')
      .toLocaleLowerCase();
    const words = phrase.match(/[\p{L}\p{N}]+/gu)?.length || 0;
    if (phrase && words >= minimumWords && words <= 15 && !phrases.includes(phrase)) phrases.push(phrase);
  };
  const expression = /"([^"\n]{3,})"|“([^”\n]{3,})”|'([^'\n]{3,})'|‘([^’\n]{3,})’/gu;
  for (const match of String(value || '').matchAll(expression)) {
    add(match.slice(1).find(Boolean));
  }
  const raw = normalizedComparableText(value);
  for (const match of raw.matchAll(/\b(?:saying|said|phrase|statement|words)\b(?:\s+(?:that|of))?\s+(.+)$/giu)) {
    add(match[1], 3);
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

function formatTsqueryTerm(term) {
  if (!term || typeof term !== 'string') return '';
  const clean = term.trim();
  if (!clean) return '';
  if (clean.includes(' ')) {
    const parts = clean.split(/\s+/).filter(Boolean);
    const validParts = parts.map((p) => p.replace(/['\\:!&|()<>*]/g, '')).filter(Boolean);
    if (!validParts.length) return '';
    return validParts.map((p) => `'${p}'`).join(' <-> ');
  }
  const stripped = clean.replace(/['\\:!&|()<>*]/g, '');
  return stripped ? `'${stripped}'` : '';
}

function buildLexicalQuery(question, { expandSpiritual = false } = {}) {
  const cleanQuery = foldDiacritics(String(question || ''));
  const tokens = significantTokens(cleanQuery);
  const baseTokens = tokens.length ? tokens : [...new Set(tokenizeSearchText(cleanQuery))];
  if (!expandSpiritual) {
    return baseTokens.join(' OR ');
  }

  // 1. Detect any multi-word spiritual terms in the question (e.g. "holy spirit", "worldly life")
  const multiWordMatches = typeof findMultiWordSpiritualTerms === 'function'
    ? findMultiWordSpiritualTerms(question)
    : [];

  const matchedPhraseWords = new Set();
  const clusters = [];
  const singleClusterTerms = [];

  for (const match of multiWordMatches) {
    const phraseVariants = match.variants || [match.phrase];
    const phraseTokens = match.phrase.split(/\s+/);
    for (const pt of phraseTokens) {
      matchedPhraseWords.add(pt.toLowerCase());
      matchedPhraseWords.add(foldDiacritics(pt).toLowerCase());
    }
    const clusterTerms = new Set();
    for (const v of phraseVariants) {
      if (!v) continue;
      clusterTerms.add(v.toLocaleLowerCase());
      clusterTerms.add(foldDiacritics(v).toLocaleLowerCase());
    }
    const formatted = [...clusterTerms].map(formatTsqueryTerm).filter(Boolean);
    if (formatted.length > 1) {
      clusters.push(`(${formatted.join(' | ')})`);
    } else if (formatted.length === 1) {
      clusters.push(formatted[0]);
    }
  }

  // 2. Identify remaining single query tokens
  const rawTokens = tokenizeSearchText(question)
    .filter((token) => !tokens.length || !SEARCH_STOP_WORDS.has(foldDiacritics(token).toLowerCase()))
    .filter((token) => !matchedPhraseWords.has(foldDiacritics(token).toLowerCase()));
  const inputTokens = [...new Set([...baseTokens.filter((t) => !matchedPhraseWords.has(t.toLowerCase())), ...rawTokens])];

  for (const token of inputTokens) {
    const clusterTerms = new Set();
    clusterTerms.add(token);
    clusterTerms.add(token.toLocaleLowerCase());
    const canonical = getCanonicalSpiritualTerm(token);
    if (canonical) {
      clusterTerms.add(canonical);
      clusterTerms.add(canonical.toLocaleLowerCase());
    }
    const variants = [
      ...getSpiritualVariants(token),
      ...(canonical && canonical !== token ? getSpiritualVariants(canonical) : []),
    ];
    for (const v of variants) {
      if (!v) continue;
      clusterTerms.add(v);
      clusterTerms.add(v.toLocaleLowerCase());
      clusterTerms.add(foldDiacritics(v).toLocaleLowerCase());
    }
    singleClusterTerms.push([...clusterTerms]);
    const formatted = [...clusterTerms].map(formatTsqueryTerm).filter(Boolean);
    if (formatted.length > 1) {
      clusters.push(`(${formatted.join(' | ')})`);
    } else if (formatted.length === 1) {
      clusters.push(formatted[0]);
    }
  }

  if (clusters.length === 0) return '';
  if (clusters.length === 1 && multiWordMatches.length === 0 && singleClusterTerms.length === 1) {
    // Single concept: keep standard broad OR format for websearch_to_tsquery and regression tests
    return singleClusterTerms[0].join(' OR ');
  }
  return clusters.join(' & ');
}

function stemToken(word) {
  if (!word || typeof word !== 'string') return '';
  const w = word.toLocaleLowerCase();
  const inflections = { baked: 'bake', baking: 'bake', cured: 'cure', curing: 'cure', driving: 'drive', drove: 'drive', frozen: 'freeze', freezing: 'freeze', made: 'make', making: 'make', ran: 'run', bought: 'buy', sold: 'sell', fed: 'feed', ate: 'eat', eaten: 'eat', drank: 'drink', drunk: 'drink' };
  if (inflections[w]) return inflections[w];
  if (w.length <= 3) return w;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 5) {
    const base = w.slice(0, -3);
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1);
    }
    return base;
  }
  if (w.endsWith('ed') && w.length > 4) {
    const base = w.slice(0, -2);
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1);
    }
    return base;
  }
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 3) {
    return w.slice(0, -1);
  }
  return w;
}

const CRITICAL_ACTION_VERBS = new Set([
  'heat', 'cook', 'bake', 'warm', 'cool', 'freeze',
  'burn', 'kill', 'cure', 'heal', 'destroy', 'clean', 'wash',
  'fly', 'drive', 'swim', 'run', 'walk', 'travel',
  'eat', 'drink', 'feed', 'grow', 'plant',
  'buy', 'sell', 'pay', 'charge', 'cost',
  'build', 'make', 'repair', 'fix',
  'ignite', 'extinguish', 'power', 'replace', 'increase', 'decrease', 'substitute', 'convert',
]);

function coverage(needles, haystack) {
  if (!needles.length) return 0;
  const values = new Set(tokenizeSearchText(haystack));
  return needles.filter((token) => values.has(token)).length / needles.length;
}

function conceptCoverage(needles, haystack) {
  if (!needles.length) return 1;
  const hayTokens = new Set(tokenizeSearchText(haystack));
  const hayList = [...hayTokens];
  const hayStems = new Set(hayList.map((t) => stemToken(t)));
  let covered = 0;
  for (const needle of needles) {
    const cleanNeedle = needle.toLocaleLowerCase();
    if (hayTokens.has(cleanNeedle)) {
      covered++;
      continue;
    }
    const needleStem = stemToken(cleanNeedle);
    if (needleStem && hayStems.has(needleStem)) {
      covered++;
      continue;
    }
    const canonical = typeof getCanonicalSpiritualTerm === 'function' ? getCanonicalSpiritualTerm(needle) : null;
    if (canonical) {
      const cleanCanonical = canonical.toLocaleLowerCase();
      if (hayTokens.has(cleanCanonical) || hayStems.has(stemToken(cleanCanonical))) {
        covered++;
        continue;
      }
    }
    const variants = typeof getSpiritualVariants === 'function' ? getSpiritualVariants(needle) : [];
    if (variants.some((v) => hayTokens.has(v.toLocaleLowerCase()) || hayTokens.has(foldDiacritics(v).toLocaleLowerCase()) || hayStems.has(stemToken(v)))) {
      covered++;
      continue;
    }
  }
  return covered / needles.length;
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
  const title = String(row?.question || '').trim();
  const titleIntent = questionIntent(title);
  const beginning = String(row?.answer || '').slice(0, 1200).toLocaleLowerCase();
  const identityBeginning = beginning.slice(0, 500);
  let positive = titleIntent === intent ? 0.55 : 0;
  let conflict = 0;

  if (intent === 'who') {
    if (/^\s*who\s+(?:is|was)\b|\b(?:brief\s+)?biograph(?:y|ical)\b/i.test(title)) {
      positive += 0.55;
    }
    if (/\b(?:god datta incarnated as|avatar of|incarnation of|who is swami)\b/i.test(title)) {
      positive += 0.55;
    }
    if (/^\s*(?:my name is|this is)\b|\b(?:is|was) (?:also )?known as\b|\b(?:was born|is an? (?:author|teacher|professor|founder|incarnation))\b/i.test(identityBeginning)) {
      positive += 0.45;
    }
    // Severe intent conflict: "who" identity question answered by meeting/contact phone info
    if (/\b(?:how to meet|where (?:can i|to) meet|contact details|phone number)\b/i.test(title) ||
        /\b(?:you can contact|phone\s*0-|\bcontact\s+(?:shri|mr|dr)\b|\bcall\s+on\s+phone\b)/i.test(beginning)) {
      conflict = 0.85;
    }
  }
  if (intent === 'where') {
    if (/\b(address|located|location|visit|meet|phone|contact|city|village|country)\b/i.test(beginning)) positive += 0.45;
    if (/\b(?:where (?:is|can|to))\b/i.test(title)) positive += 0.40;
  }
  if (intent === 'when' && /\b(?:in|on|during|before|after)\s+(?:the\s+)?(?:year\s+)?\d{2,4}\b/i.test(beginning)) positive += 0.45;
  if (intent === 'how' && /\b(first|next|then|finally|method|process|steps?)\b/i.test(beginning)) positive += 0.35;
  return { positive: Math.min(1, positive), conflict: Math.min(1, conflict) };
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
  const sourceContext = row?.metadata?.question_context || row?.metadata?.source_context || '';
  const contextCoverage = coverage(queryTokens, sourceContext);
  const intent = intentSignals(query, row);
  const position = chunkPositionPrior(row, titleCoverage, intent.positive);
  const queryKey = significantTokens(query).join(' ');
  const titleKey = significantTokens(row.question).join(' ');
  const contextKey = significantTokens(sourceContext).join(' ');
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

function rerankPassageMatches(rows, query, limit = 5, threshold = null) {
  const records = new Map();
  for (const row of rows) {
    const key = String(row.sourceId);
    if (!records.has(key)) records.set(key, []);
    records.get(key).push(row);
  }

  const rankedRecords = [];
  for (const sourceRows of records.values()) {
    const cleanQuery = normalizedComparableText(query).toLocaleLowerCase().replace(/[?.,!;:\s-]+/gu, ' ').trim();
    const cleanTitle = normalizedComparableText(sourceRows[0]?.question || '').toLocaleLowerCase().replace(/[?.,!;:\s-]+/gu, ' ').trim();
    const exactQuestionMatch = Boolean(cleanQuery && cleanTitle && cleanQuery === cleanTitle);
    const titlePhraseMatch = Boolean(
      cleanQuery && cleanTitle && cleanQuery.length >= 8 && (cleanTitle.includes(cleanQuery) || cleanQuery.includes(cleanTitle))
    );
    const queryTokens = significantTokens(cleanQuery);
    const titleCoverage = coverage(queryTokens, cleanTitle);

    const mappedPassages = sourceRows.map((row) => {
      const semanticSimilarity = Math.max(0, Math.min(1, Number(row.similarity) || 0));
      const lexicalScore = Number(row.lexicalScore) || 0;
      const discoverySimilarity = Math.max(0, Math.min(1, Number(row.discoverySimilarity) || 0));
      const discoveryExact = row.discoveryExact === true && Boolean(row.answerUnitId) &&
        row.discoveryAnswerUnitId === row.answerUnitId;
      const associatedQuestion = row.associatedQuestion || '';
      // Item 2: Reserve isExact exception for verified question-to-answer-unit match
      const isExact = discoveryExact;

      // Item 10: Real hybrid ranking with lexical score weighting in passage relevance
      const rawLexicalScore = Math.max(0, Number(row.lexicalScore) || 0);
      const lexicalBoost = Math.min(0.08, rawLexicalScore * 0.15);

      // Continuous smoothstep blending without cliff at 0.35:
      let effectiveBaseSimilarity;
      let passageTitleBoost = 0;
      let passageLexicalBoost = 0;
      if (isExact) {
        effectiveBaseSimilarity = Math.max(semanticSimilarity, discoverySimilarity);
        passageTitleBoost = 0.10;
        passageLexicalBoost = lexicalBoost;
      } else if (semanticSimilarity < 0.20) {
        // When answer similarity is low, non-exact discovery and titles cannot certify off-topic answers
        effectiveBaseSimilarity = semanticSimilarity;
        passageTitleBoost = 0;
        passageLexicalBoost = 0;
      } else {
        // Smoothstep curve between 0.20 and 0.60
        const t = Math.max(0, Math.min(1, (semanticSimilarity - 0.20) / 0.40));
        const smoothWeight = t * t * (3 - 2 * t);
        const discoveryTarget = discoverySimilarity * 0.95;
        const discoveryDelta = Math.max(0, discoveryTarget - semanticSimilarity) * smoothWeight;
        effectiveBaseSimilarity = semanticSimilarity + discoveryDelta;

        const titleCoverageBoost = titleCoverage >= 0.40 ? titleCoverage * 0.06 * smoothWeight : 0;
        if (exactQuestionMatch) {
          passageTitleBoost = 0.10 * smoothWeight;
        } else if (titlePhraseMatch) {
          passageTitleBoost = Math.max(0.05 * smoothWeight, titleCoverageBoost);
        } else if (discoverySimilarity > 0.70) {
          passageTitleBoost = Math.max(titleCoverageBoost, (discoverySimilarity - 0.70) * 0.08 * smoothWeight);
        } else {
          passageTitleBoost = titleCoverageBoost;
        }
        passageLexicalBoost = lexicalBoost * smoothWeight;
      }

      const initialRelevance = Math.min(1, effectiveBaseSimilarity + passageTitleBoost + passageLexicalBoost);

      return {
        sourceId: row.sourceId,
        passageIndex: Number(row.passageIndex),
        text: row.passageText,
        start: Number(row.passageStart),
        end: Number(row.passageEnd),
        semanticSimilarity,
        lexicalScore,
        lexicalBoost: passageLexicalBoost,
        discoverySimilarity,
        discoveryExact,
        isExact,
        titleBoost: passageTitleBoost,
        answerUnitId: row.answerUnitId || null,
        author: row.author || '',
        unitKind: row.unitKind || '',
        associatedQuestion,
        citationStart: Number(row.citationStart),
        citationEnd: Number(row.citationEnd),
        citationText: row.citationText || row.passageText,
        contextComplete: row.contextComplete !== false,
        storyComplete: row.storyComplete !== false,
        matchChannels: Array.isArray(row.matchChannels) ? row.matchChannels : [],
        relevanceScore: initialRelevance,
      };
    });

    const passages = mappedPassages.sort((left, right) => (
      right.relevanceScore - left.relevanceScore ||
      right.semanticSimilarity - left.semanticSimilarity ||
      right.lexicalScore - left.lexicalScore ||
      left.passageIndex - right.passageIndex
    ));

    if (!passages.length) continue;

    const best = passages[0];
    const representative = sourceRows.find((row) => Number(row.passageIndex) === best.passageIndex) || sourceRows[0];
    const candidateCorpusText = `${best.text} ${cleanTitle} ${best.associatedQuestion || ''} ${representative.question || ''}`;
    const substantiveCoverage = conceptCoverage(queryTokens, candidateCorpusText);
    const actionOrPhysicalTask = /\b(?:temperature|degrees?|watts?|voltage|lumens|diameter|radius|orbital|dosage|boil|cook|bake|heat|warm|cool|freeze|melt|weld|extinguish|ignite|puncture|tyre|tire|gasoline|battery|effluent|scalpel|tuberculosis|insulin|antibiotic|refrigerator|mileage|engine|sahara|desert|chemical|stadium|arena|illuminate|illumination|lighting|appliance|generator)\b/iu.test(query);
    const requestTokens = queryTokens.filter((token) => !['use', 'using', 'suitable', 'provide', 'based'].includes(token));
    // Co-occurrence across a long document is not evidence for the requested task.
    const nonsenseQuery = /\b(?:bla\s+bla|word\s+salad|random\s+text|asdf|qwer|zxcv|gibberish)\b/iu.test(query);
    const taskSupported = !nonsenseQuery && (!actionOrPhysicalTask || best.isExact ||
      (conceptCoverage(requestTokens, cleanTitle) >= 0.85) ||
      (representative.question && conceptCoverage(requestTokens, representative.question) >= 0.85) ||
      String(best.text || '').split(/(?<=[.!?;])\s+|\n+|\b(?:because|whereas|although|but|instead(?:\s+of)?|rather\s+than|however|on\s+the\s+contrary)\b/iu).some((clause) => conceptCoverage(requestTokens, clause) >= 0.85));
    const authorSupported = passages.some((passage) => isCitableSwamiUnit({ author: passage.author || 'Swami', unitKind: passage.unitKind, text: passage.text, displayText: representative.answer }));

    let unanchoredFactor = 1.0;
    const qIntent = questionIntent(query);
    const queryActionVerbs = queryTokens.filter((t) => CRITICAL_ACTION_VERBS.has(stemToken(t)));
    const decisionActionMissing = Boolean(
      (qIntent === 'decision' || queryActionVerbs.length > 0) &&
      queryActionVerbs.length > 0 &&
      conceptCoverage(queryActionVerbs, candidateCorpusText) === 0
    );

    if (!best.isExact && best.semanticSimilarity < 0.65 && (best.discoverySimilarity || 0) < 0.60 && queryTokens.length >= 2 && (best.lexicalScore === 0 || !best.lexicalScore)) {
      if (decisionActionMissing) {
        unanchoredFactor = 0.15;
      } else if (substantiveCoverage < 0.35) {
        unanchoredFactor = Math.pow(Math.max(0.1, substantiveCoverage), 1.5);
      }
    } else if (decisionActionMissing && !best.isExact) {
      unanchoredFactor = 0.15;
    }

    const supportingPassages = passages.filter((passage, index) => (
      index > 0 && passage.semanticSimilarity >= Math.max(0.35, best.semanticSimilarity - 0.12)
    )).length;
    const isGrounded = (best.semanticSimilarity >= 0.52 || (best.lexicalScore || 0) > 0 || best.isExact) && substantiveCoverage >= 0.50 && !decisionActionMissing;
    const supportBonus = isGrounded ? Math.min(0.03, supportingPassages * 0.015) : 0;

    const intent = intentSignals(query, { question: cleanTitle || representative.question, answer: best.text });
    const intentAdjustment = (intent.positive * 0.10) - (intent.conflict * 0.25);

    const baseRelevance = (best.relevanceScore * unanchoredFactor) + supportBonus;
    const relevanceScore = Math.max(0, Math.min(1, baseRelevance + intentAdjustment));

    rankedRecords.push({
      ...representative,
      similarity: best.semanticSimilarity,
      lexicalScore: best.lexicalScore,
      relevanceScore,
      matchedPassages: passages.slice(0, 5),
      rankingSignals: {
        supportingPassages,
        lexicalWeight: Number((best.lexicalBoost || 0).toFixed(4)),
        titleWeight: best.titleBoost,
        questionWeight: exactQuestionMatch ? 1 : 0,
        exactQaDiscovery: best.isExact,
        substantiveCoverage: Number(substantiveCoverage.toFixed(4)),
        decisionActionMissing,
        taskSupported,
        authorSupported,
        intent: intent.positive,
        intentConflict: intent.conflict,
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
  return orderMatches([...groups.values()], query, threshold)
    .slice(0, Math.max(1, Number(limit) || 5));
}

// Use the same guarded passage scores and ordering before database result caps.
function rankPassageRows(rows, query, limit, threshold = null) {
  const originals = new Map(rows.map((row) => [`${row.sourceId}:${row.passageIndex}`, row]));
  const passages = rerankPassageMatches(rows, query, Math.max(1, rows.length), threshold)
    .flatMap((record) => record.matchedPassages.map((passage) => ({
      sourceId: record.sourceId,
      passageIndex: passage.passageIndex,
      similarity: passage.semanticSimilarity,
      relevanceScore: passage.relevanceScore,
      rankingSignals: { exactQaDiscovery: passage.isExact },
      matchedPassages: [passage],
    })));
  return orderMatches(passages, query, threshold).slice(0, limit)
    .map((passage) => originals.get(`${passage.sourceId}:${passage.passageIndex}`))
    .filter(Boolean);
}

function rerankTextMatches(rows, limit = 5) {
  const records = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row.sourceId);
    if (!records.has(key)) records.set(key, []);
    records.get(key).push(row);
  }
  const ranked = [];
  for (const sourceRows of records.values()) {
    const passages = sourceRows.map((row) => ({
      sourceId: row.sourceId,
      passageIndex: Number(row.passageIndex),
      text: row.passageText,
      start: Number(row.passageStart),
      end: Number(row.passageEnd),
      searchScore: Math.max(0, Math.min(1, Number(row.searchScore) || 0)),
      semanticSimilarity: Math.max(0, Math.min(1, Number(row.searchScore) || 0)),
      lexicalScore: Number(row.lexicalScore) || 0,
      trigramSimilarity: Number(row.trigramSimilarity) || 0,
      matchChannels: Array.isArray(row.matchChannels) ? row.matchChannels : [],
      answerUnitId: row.answerUnitId || null,
      author: row.author || '',
      unitKind: row.unitKind || '',
      associatedQuestion: row.associatedQuestion || '',
      citationStart: Number(row.citationStart),
      citationEnd: Number(row.citationEnd),
      citationText: row.citationText || row.passageText,
      contextComplete: row.contextComplete !== false,
      storyComplete: row.storyComplete !== false,
    })).sort((left, right) => (
      right.searchScore - left.searchScore ||
      right.lexicalScore - left.lexicalScore ||
      right.trigramSimilarity - left.trigramSimilarity ||
      left.passageIndex - right.passageIndex
    ));
    if (!passages.length) continue;
    const best = passages[0];
    const representative = sourceRows.find((row) => Number(row.passageIndex) === best.passageIndex) || sourceRows[0];
    ranked.push({
      ...representative,
      similarity: best.searchScore,
      relevanceScore: best.searchScore,
      searchScore: best.searchScore,
      matchedPassages: passages.slice(0, 5),
      matchChannels: [...new Set(passages.flatMap((passage) => passage.matchChannels))],
      retrievalMode: 'search',
      rankingSignals: { algorithm: 'reciprocal-rank-fusion', semanticWeight: 0 },
    });
  }
  const groups = new Map();
  for (const row of ranked) {
    const key = isDocumentChunk(row) ? `document:${String(row.sourceGroup)}` : `record:${String(row.sourceId)}`;
    const current = groups.get(key);
    if (!current || row.relevanceScore > current.relevanceScore) groups.set(key, row);
  }
  return [...groups.values()]
    .sort((left, right) => right.relevanceScore - left.relevanceScore || String(left.sourceId).localeCompare(String(right.sourceId)))
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

function orderMatches(rows, query = '', threshold = null) {
  const phrases = quotedPhrases(query);
  const hasQuotedMatch = phrases.length && rows.some((row) => passageMatchesQuotedPhrases(row, phrases));
  const numericThreshold = threshold != null && Number.isFinite(Number(threshold)) ? Number(threshold) : null;

  return [...rows]
    .sort((a, b) => {
      const aScore = Number(a.relevanceScore ?? a.similarity);
      const bScore = Number(b.relevanceScore ?? b.similarity);
      if (numericThreshold !== null) {
        const aEligible = aScore >= numericThreshold;
        const bEligible = bScore >= numericThreshold;
        if (aEligible !== bEligible) return Number(bEligible) - Number(aEligible);
      }
      return (
        Number(Boolean(b.rankingSignals?.exactQaDiscovery)) - Number(Boolean(a.rankingSignals?.exactQaDiscovery)) ||
        (hasQuotedMatch
          ? Number(passageMatchesQuotedPhrases(b, phrases)) - Number(passageMatchesQuotedPhrases(a, phrases))
          : 0) ||
        bScore - aScore ||
        Number(b.similarity) - Number(a.similarity) ||
        String(a.sourceId).localeCompare(String(b.sourceId))
      );
    })
    .map((row, index) => ({ ...row, similarity: Number(row.similarity), relevanceRank: index + 1 }));
}

function buildSearchResponse(rows, threshold, query = '') {
  const numericThreshold = Number(threshold);
  const matches = orderMatches(rows, query, numericThreshold);
  const phrases = quotedPhrases(query);
  const acceptedMatch = matches.find((m) => {
    if (m.rankingSignals?.taskSupported === false || m.rankingSignals?.authorSupported === false) return false;
    if (m.rankingSignals?.decisionActionMissing) return false;
    const score = Number(m.relevanceScore ?? m.similarity);
    if (score < numericThreshold) return false;
    if (m.isExact || m.rankingSignals?.exactQaDiscovery) return true;
    if (phrases.length && passageMatchesQuotedPhrases(m, phrases)) return true;
    if (Number(m.similarity) >= 0.65) return true;
    const substantiveCoverage = m.rankingSignals?.substantiveCoverage ?? 1;
    if ((m.lexicalScore || 0) > 0 && substantiveCoverage >= 0.35) return true;
    if (score >= 0.55 && (substantiveCoverage >= 0.35 || (m.discoverySimilarity || 0) >= 0.60)) return true;
    if (substantiveCoverage >= 0.35 && (m.similarity || 0) >= 0.50) return true;
    return false;
  }) || null;
  const strongMatch = Boolean(acceptedMatch);
  return {
    strongMatch,
    ...(strongMatch ? {} : { message: NO_MATCH_MESSAGE }),
    ...(strongMatch ? { acceptedMatch } : {}),
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
  extractRequestedPhrases: quotedPhrases,
  rerankMatches,
  rerankPassageMatches,
  rankPassageRows,
  rerankTextMatches,
  scoreCandidate,
  contentHash,
  toVectorLiteral,
  orderMatches,
  buildSearchResponse,
  redactConnection,
};
