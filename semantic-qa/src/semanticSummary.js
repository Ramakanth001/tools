const SUMMARY_MODE = 'grounded-generative';
const DEFAULT_MAX_RECORDS = 15;
const DEFAULT_MAX_LINES = 3;
const MAX_RECORDS = 15;
const MAX_LINES = 5;
const DEFAULT_PASSAGES_PER_RECORD = 10;
const MAX_PASSAGES_PER_RECORD = 256;
const MAX_TOTAL_PASSAGES = 150;
const MAX_PASSAGE_CHARACTERS = 720;
const MAX_EVIDENCE_CONTEXT_CHARACTERS = 2200;
const MIN_PASSAGE_CHARACTERS = 24;
const MIN_RECORD_DENSE_SIMILARITY = 0.30;
const ANSWER_CUE_ANY_RE = /(?:(?:answer|response)\s*[:\-]|[\p{L}\p{M}][^.?!:\n]{0,79}\s+(?:replied|answered|responded)\s*[:\-])/iu;

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function normalizeEvidenceText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function extractQuotedPhrases(value) {
  const phrases = [];
  const expression = /"([^"\n]{3,})"|“([^”\n]{3,})”|'([^'\n]{3,})'|‘([^’\n]{3,})’/gu;
  for (const match of String(value || '').matchAll(expression)) {
    const phrase = normalizeEvidenceText(match.slice(1).find(Boolean));
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

function trimSpan(text, start, end) {
  let left = Math.max(0, start);
  let right = Math.min(text.length, end);
  while (left < right && /\s/u.test(text[left])) left += 1;
  while (right > left && /\s/u.test(text[right - 1])) right -= 1;
  return { start: left, end: right };
}

function sentenceSpans(text) {
  if (!text) return [];
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    return [...segmenter.segment(text)]
      .map((segment) => trimSpan(text, segment.index, segment.index + segment.segment.length))
      .filter((span) => span.end > span.start);
  }
  const spans = [];
  const expression = /[^.!?。！？\n]+(?:[.!?。！？]+|(?=\n|$))|\n+/gu;
  for (const match of text.matchAll(expression)) {
    const span = trimSpan(text, match.index, match.index + match[0].length);
    if (span.end > span.start) spans.push(span);
  }
  return spans.length ? spans : [trimSpan(text, 0, text.length)];
}

function splitOversizedSpan(text, span, maxCharacters) {
  const spans = [];
  let cursor = span.start;
  while (span.end - cursor > maxCharacters) {
    const target = cursor + maxCharacters;
    const minimumBreak = cursor + Math.floor(maxCharacters * 0.60);
    let cut = target;
    while (cut > minimumBreak && !/\s/u.test(text[cut])) cut -= 1;
    if (cut <= minimumBreak) cut = target;
    const piece = trimSpan(text, cursor, cut);
    if (piece.end > piece.start) spans.push(piece);
    cursor = cut;
    while (cursor < span.end && /\s/u.test(text[cursor])) cursor += 1;
  }
  const tail = trimSpan(text, cursor, span.end);
  if (tail.end > tail.start) spans.push(tail);
  return spans;
}

function sampleEvenly(values, limit) {
  if (values.length <= limit) return values;
  if (limit <= 1) return [values[0]];
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (values.length - 1) / (limit - 1));
    if (!seen.has(sourceIndex)) {
      selected.push(values[sourceIndex]);
      seen.add(sourceIndex);
    }
  }
  return selected;
}

function splitAnswerIntoPassages(answer, {
  maxCharacters = MAX_PASSAGE_CHARACTERS,
  maxPassages = DEFAULT_PASSAGES_PER_RECORD,
} = {}) {
  const text = String(answer || '');
  if (!text.trim()) return [];
  const sentenceUnits = sentenceSpans(text)
    .flatMap((span) => splitOversizedSpan(text, span, maxCharacters));
  const grouped = [];
  let current = null;
  let sentenceCount = 0;

  const pushCurrent = () => {
    if (!current) return;
    const span = trimSpan(text, current.start, current.end);
    const passageText = text.slice(span.start, span.end);
    if (passageText.length) {
      grouped.push({ text: passageText, start: span.start, end: span.end });
    }
    current = null;
    sentenceCount = 0;
  };

  for (const unit of sentenceUnits) {
    if (!current) {
      current = { ...unit };
      sentenceCount = 1;
      continue;
    }
    const combinedLength = unit.end - current.start;
    const gap = text.slice(current.end, unit.start);
    const paragraphBreak = /\n\s*\n/u.test(gap);
    if (combinedLength > maxCharacters || sentenceCount >= 3 || paragraphBreak) {
      pushCurrent();
      current = { ...unit };
      sentenceCount = 1;
    } else {
      current.end = unit.end;
      sentenceCount += 1;
    }
  }
  pushCurrent();

  const compacted = [];
  for (let index = 0; index < grouped.length; index += 1) {
    const passage = grouped[index];
    if (passage.text.length >= MIN_PASSAGE_CHARACTERS) {
      compacted.push(passage);
      continue;
    }
    const previous = compacted.at(-1);
    if (previous && passage.end - previous.start <= maxCharacters) {
      previous.end = passage.end;
      previous.text = text.slice(previous.start, previous.end).trim();
      continue;
    }
    const next = grouped[index + 1];
    if (next && next.end - passage.start <= maxCharacters) {
      grouped[index + 1] = {
        start: passage.start,
        end: next.end,
        text: text.slice(passage.start, next.end).trim(),
      };
      continue;
    }
    compacted.push(passage);
  }

  const deduplicated = [];
  const seen = new Set();
  for (const passage of compacted) {
    const key = normalizeEvidenceText(passage.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(passage);
  }
  return sampleEvenly(deduplicated, clampInteger(maxPassages, 1, MAX_PASSAGES_PER_RECORD, DEFAULT_PASSAGES_PER_RECORD));
}

function splitAnswerForIndex(answer, options = {}) {
  const text = String(answer || '');
  const cueMatch = text.match(ANSWER_CUE_ANY_RE);
  const candidateOffset = cueMatch?.index || 0;
  const prefix = text.slice(0, candidateOffset);
  const offset = candidateOffset <= 600 && (
    /^\s*(?:\[[^\]]*\]\s*)+$/u.test(prefix) ||
    /[?？]\s*$/u.test(prefix)
  ) ? candidateOffset : 0;
  return splitAnswerIntoPassages(text.slice(offset), options).map((passage) => ({
    ...passage,
    start: passage.start + offset,
    end: passage.end + offset,
  }));
}

function filterRelevantMatches(matches, threshold, {
  maxRecords = DEFAULT_MAX_RECORDS,
  minimumDenseSimilarity = MIN_RECORD_DENSE_SIMILARITY,
  question = '',
} = {}) {
  const limit = clampInteger(maxRecords, 1, MAX_RECORDS, DEFAULT_MAX_RECORDS);
  const admitted = (Array.isArray(matches) ? matches : [])
    .filter((match) => (
      Number(match.relevanceScore ?? match.similarity) >= Number(threshold) &&
      Number(match.similarity) >= Number(minimumDenseSimilarity)
    ));
  const quotedPhrases = extractQuotedPhrases(question);
  if (quotedPhrases.length) {
    const quoteMatched = admitted.filter((match) => (
      (Array.isArray(match.matchedPassages) ? match.matchedPassages : [])
        .some((passage) => {
          const text = normalizeEvidenceText(passage.text);
          return quotedPhrases.every((phrase) => text.includes(phrase));
        })
    ));
    if (quoteMatched.length) return quoteMatched.slice(0, limit);
  }
  return admitted.slice(0, limit);
}

function buildEvidencePassages(matches) {
  const passages = [];
  const seen = new Set();
  for (const match of matches) {
    const indexedPassages = Array.isArray(match.matchedPassages) && match.matchedPassages.length
      ? match.matchedPassages.map((passage) => ({
        text: passage.text,
        start: passage.start,
        end: passage.end,
        semanticSimilarity: Number(passage.semanticSimilarity),
        lexicalScore: Number(passage.lexicalScore) || 0,
      }))
      : null;
    const sourcePassages = indexedPassages || splitAnswerForIndex(match.answer);
    const answerPassages = sourcePassages;
    for (const passage of answerPassages) {
      const key = normalizeEvidenceText(passage.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      passages.push({
        ...passage,
        sourceId: match.sourceId,
        sourceGroup: match.sourceGroup ?? null,
        sourceOrder: match.sourceOrder ?? null,
        question: match.question,
        answer: match.answer,
        recordRelevance: Number(match.relevanceScore ?? match.similarity),
        recordSimilarity: Number(match.similarity),
        relevanceRank: match.relevanceRank ?? null,
        semanticSimilarity: Number(passage.semanticSimilarity),
      });
      if (passages.length >= MAX_TOTAL_PASSAGES) return passages;
    }
  }
  return passages;
}

function selectGroundedEvidence(passages, limit, question = '') {
  const boundedLimit = clampInteger(limit, 1, 15, 9);
  const candidates = passages
    .filter((passage) => (
      Number.isFinite(passage.semanticSimilarity) &&
      passage.semanticSimilarity >= MIN_RECORD_DENSE_SIMILARITY
    ))
    .sort((left, right) => (
      right.semanticSimilarity - left.semanticSimilarity ||
      right.recordRelevance - left.recordRelevance ||
      Number(left.relevanceRank || Number.MAX_SAFE_INTEGER) - Number(right.relevanceRank || Number.MAX_SAFE_INTEGER) ||
      String(left.sourceId).localeCompare(String(right.sourceId))
    ));
  if (!candidates.length) return [];
  const quotedPhrases = extractQuotedPhrases(question);
  const quoteMatched = quotedPhrases.length
    ? candidates.filter((passage) => {
      const text = normalizeEvidenceText(passage.text);
      return quotedPhrases.every((phrase) => text.includes(phrase));
    })
    : [];
  // A quoted phrase is a semantic identity constraint: “I am the Light” and
  // “The Light is in Me” express different relationships. Use this guard only
  // after dense admission and only when accepted evidence contains the quote.
  const directlyMapped = quoteMatched
    .map((passage) => {
      const text = normalizeEvidenceText(passage.text);
      let directness = 0;
      for (const phrase of quotedPhrases) {
        const offset = text.indexOf(phrase);
        if (offset < 0) continue;
        const suffix = text.slice(offset + phrase.length, offset + phrase.length + 180);
        const sameSentence = suffix.split(/[.!?。！？]/u, 1)[0];
        if (/^[\s\p{P}]*(?:means?|refers?\s+to|indicates?|signifies?|represents?|corresponds?\s+to|is\s+that)\b/iu.test(sameSentence)) {
          directness = Math.max(directness, 3);
        } else if (/^[^\p{L}\p{N}]{0,8}\(/u.test(sameSentence)) {
          directness = Math.max(directness, 3);
        }
      }
      return { passage, directness };
    })
    .filter((item) => item.directness > 0)
    .sort((left, right) => (
      right.directness - left.directness ||
      right.passage.semanticSimilarity - left.passage.semanticSimilarity
    ))
    .map((item) => item.passage);
  const eligible = directlyMapped.length
    ? directlyMapped
    : (quoteMatched.length ? quoteMatched : candidates);
  const selected = [];
  const usedSources = new Set();
  for (const passage of eligible) {
    if (usedSources.has(String(passage.sourceId))) continue;
    selected.push(passage);
    usedSources.add(String(passage.sourceId));
    if (selected.length >= boundedLimit) return selected;
  }
  return selected;
}

function expandEvidenceContext(passage) {
  const answer = String(passage.answer || '');
  if (!answer || !String(passage.text || '').trim()) return passage;
  const indexed = splitAnswerForIndex(answer, { maxPassages: MAX_PASSAGES_PER_RECORD });
  const centerIndex = indexed.findIndex((candidate) => (
    (Number.isFinite(Number(passage.start)) && Number.isFinite(Number(passage.end)) &&
      candidate.start === Number(passage.start) && candidate.end === Number(passage.end)) ||
    normalizeEvidenceText(candidate.text) === normalizeEvidenceText(passage.text)
  ));
  if (centerIndex < 0) return passage;

  let left = centerIndex;
  let right = centerIndex;
  const canInclude = (nextLeft, nextRight) => (
    indexed[nextRight].end - indexed[nextLeft].start <= MAX_EVIDENCE_CONTEXT_CHARACTERS
  );
  const crossesParagraph = (leftIndex, rightIndex) => (
    /\n\s*\n/u.test(answer.slice(indexed[leftIndex].end, indexed[rightIndex].start))
  );
  if (left > 0 && !crossesParagraph(left - 1, left) && canInclude(left - 1, right)) left -= 1;
  if (right + 1 < indexed.length && !crossesParagraph(right, right + 1) && canInclude(left, right + 1)) right += 1;
  const span = trimSpan(answer, indexed[left].start, indexed[right].end);
  return {
    ...passage,
    text: answer.slice(span.start, span.end),
    start: span.start,
    end: span.end,
  };
}

function compactRelevantMatch(match) {
  return {
    sourceId: match.sourceId,
    question: match.question,
    relevanceScore: Number(match.relevanceScore ?? match.similarity),
    similarity: Number(match.similarity),
    relevanceRank: match.relevanceRank ?? null,
    sourceGroup: match.sourceGroup ?? null,
    sourceOrder: match.sourceOrder ?? null,
  };
}

async function buildSemanticSummary({
  question,
  matches,
  threshold,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxLines = DEFAULT_MAX_LINES,
  baseUrl,
  model,
  generateAnswer,
}) {
  const relevant = filterRelevantMatches(matches, threshold, { maxRecords, question });
  const relevantMatches = relevant.map(compactRelevantMatch);
  if (!relevant.length) {
    return {
      relevantMatches,
      summary: {
        status: 'not_available',
        mode: SUMMARY_MODE,
        reason: 'no_relevant_records',
        evidence: [],
      },
    };
  }

  const passages = buildEvidencePassages(relevant);
  if (!passages.length) {
    return {
      relevantMatches,
      summary: {
        status: 'not_available',
        mode: SUMMARY_MODE,
        reason: 'no_relevant_passages',
        evidence: [],
      },
    };
  }

  const selected = selectGroundedEvidence(
    passages,
    Math.min(15, Math.max(1, Number(maxRecords) || DEFAULT_MAX_RECORDS)),
    question,
  );
  const allowedSources = new Set(relevantMatches.map((match) => String(match.sourceId)));
  const candidateEvidence = selected
    .filter((candidate) => (
      allowedSources.has(String(candidate.sourceId)) &&
      String(candidate.answer).includes(candidate.text)
    ))
    .map(expandEvidenceContext)
    .map((candidate) => ({
      sourceId: candidate.sourceId,
      sourceGroup: candidate.sourceGroup,
      sourceOrder: candidate.sourceOrder,
      question: candidate.question,
      text: candidate.text,
      semanticSimilarity: candidate.semanticSimilarity,
      recordRelevance: candidate.recordRelevance,
      relevanceRank: candidate.relevanceRank,
    }));

  if (!candidateEvidence.length) {
    return {
      relevantMatches,
      summary: {
        status: 'not_available',
        mode: SUMMARY_MODE,
        reason: 'no_semantically_relevant_passages',
        evidence: [],
      },
    };
  }
  if (typeof generateAnswer !== 'function') {
    throw new Error('A local summary model is not available');
  }
  const generated = await generateAnswer({
    baseUrl,
    model,
    question,
    evidence: candidateEvidence,
    maxSentences: maxLines,
  });
  if (generated.answerable === false) {
    return {
      relevantMatches: [],
      summary: {
        status: 'not_available',
        mode: SUMMARY_MODE,
        reason: 'no_answerable_evidence',
        evidence: [],
      },
    };
  }
  const evidence = generated.evidenceNumbers.map((number) => ({
    ...candidateEvidence[number - 1],
    evidenceNumber: number,
  }));

  return {
    relevantMatches,
    summary: {
      status: 'ready',
      mode: SUMMARY_MODE,
      text: generated.answer,
      evidence,
      sourceCount: new Set(evidence.map((item) => String(item.sourceId))).size,
      candidateRecordCount: relevant.length,
      evidenceCount: evidence.length,
    },
  };
}

module.exports = {
  SUMMARY_MODE,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_LINES,
  MAX_RECORDS,
  MAX_LINES,
  normalizeEvidenceText,
  extractQuotedPhrases,
  splitAnswerIntoPassages,
  splitAnswerForIndex,
  filterRelevantMatches,
  buildEvidencePassages,
  selectGroundedEvidence,
  buildSemanticSummary,
};
