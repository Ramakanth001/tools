const { buildDocumentEmbeddingText } = require('./core');

const SUMMARY_MODE = 'semantic-extractive';
const DEFAULT_MAX_RECORDS = 15;
const DEFAULT_MAX_LINES = 3;
const MAX_RECORDS = 15;
const MAX_LINES = 5;
const MAX_PASSAGES_PER_RECORD = 10;
const MAX_TOTAL_PASSAGES = 150;
const MAX_PASSAGE_CHARACTERS = 480;
const MIN_PASSAGE_CHARACTERS = 24;
const EMBEDDING_BATCH_SIZE = 32;
const MIN_RECORD_DENSE_SIMILARITY = 0.30;
const MIN_PASSAGE_SEMANTIC_SIMILARITY = 0.35;
const RELATIVE_PASSAGE_WINDOW = 0.18;
const ANSWER_CUE_BONUS = 0.16;
const ANSWER_CUE_RE = /^\s*(?:\[[^\]]*\]\s*)?(?:(?:answer|response)\s*|[^:\n]{1,80}\s+(?:replied|answered|responded)\s*)[:\-]/iu;

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function normalizeEvidenceText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
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
  maxPassages = MAX_PASSAGES_PER_RECORD,
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
    if (passageText.length >= MIN_PASSAGE_CHARACTERS || (!grouped.length && sentenceUnits.length === 1)) {
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
    if (combinedLength > maxCharacters || sentenceCount >= 2 || paragraphBreak) {
      pushCurrent();
      current = { ...unit };
      sentenceCount = 1;
    } else {
      current.end = unit.end;
      sentenceCount += 1;
    }
  }
  pushCurrent();

  const deduplicated = [];
  const seen = new Set();
  for (const passage of grouped) {
    const key = normalizeEvidenceText(passage.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(passage);
  }
  return sampleEvenly(deduplicated, clampInteger(maxPassages, 1, MAX_PASSAGES_PER_RECORD, MAX_PASSAGES_PER_RECORD));
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) {
    throw new Error('Summary embeddings have incompatible dimensions');
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Summary embedding contains an invalid value');
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function filterRelevantMatches(matches, threshold, {
  maxRecords = DEFAULT_MAX_RECORDS,
  minimumDenseSimilarity = MIN_RECORD_DENSE_SIMILARITY,
} = {}) {
  const limit = clampInteger(maxRecords, 1, MAX_RECORDS, DEFAULT_MAX_RECORDS);
  return (Array.isArray(matches) ? matches : [])
    .filter((match) => (
      Number(match.relevanceScore ?? match.similarity) >= Number(threshold) &&
      Number(match.similarity) >= Number(minimumDenseSimilarity)
    ))
    .slice(0, limit);
}

function buildEvidencePassages(matches) {
  const passages = [];
  const seen = new Set();
  for (const match of matches) {
    const sourcePassages = splitAnswerIntoPassages(match.answer);
    const answerStart = sourcePassages.findIndex((passage) => ANSWER_CUE_RE.test(passage.text));
    const answerPassages = answerStart >= 0 ? sourcePassages.slice(answerStart) : sourcePassages;
    for (const passage of answerPassages) {
      const key = normalizeEvidenceText(passage.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      passages.push({
        ...passage,
        answerCue: ANSWER_CUE_RE.test(passage.text),
        sourceId: match.sourceId,
        sourceGroup: match.sourceGroup ?? null,
        sourceOrder: match.sourceOrder ?? null,
        question: match.question,
        answer: match.answer,
        recordRelevance: Number(match.relevanceScore ?? match.similarity),
        recordSimilarity: Number(match.similarity),
        relevanceRank: match.relevanceRank ?? null,
      });
      if (passages.length >= MAX_TOTAL_PASSAGES) return passages;
    }
  }
  return passages;
}

async function embedInBatches(embedTexts, config, texts, batchSize = EMBEDDING_BATCH_SIZE) {
  const vectors = [];
  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    const embedded = await embedTexts({ ...config, texts: batch });
    if (!Array.isArray(embedded) || embedded.length !== batch.length) {
      throw new Error('Ollama returned an incomplete summary embedding batch');
    }
    vectors.push(...embedded);
  }
  return vectors;
}

function selectDiverseEvidence(candidates, maxLines) {
  const limit = clampInteger(maxLines, 1, MAX_LINES, DEFAULT_MAX_LINES);
  if (!candidates.length) return [];
  const topSimilarity = Math.max(...candidates.map((candidate) => candidate.semanticSimilarity));
  const admissionThreshold = Math.max(
    MIN_PASSAGE_SEMANTIC_SIMILARITY,
    topSimilarity - RELATIVE_PASSAGE_WINDOW,
  );
  const eligible = candidates
    .filter((candidate) => candidate.semanticSimilarity >= admissionThreshold)
    .sort((left, right) => (
      (right.semanticSimilarity + (right.answerCue ? ANSWER_CUE_BONUS : 0)) -
        (left.semanticSimilarity + (left.answerCue ? ANSWER_CUE_BONUS : 0)) ||
      right.recordRelevance - left.recordRelevance ||
      String(left.sourceId).localeCompare(String(right.sourceId))
    ));
  const selected = [];
  const usedText = new Set();

  while (selected.length < limit && eligible.length) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < eligible.length; index += 1) {
      const candidate = eligible[index];
      const textKey = normalizeEvidenceText(candidate.text);
      if (usedText.has(textKey)) continue;
      const redundancy = selected.length
        ? Math.max(...selected.map((chosen) => Math.max(0, cosineSimilarity(candidate.vector, chosen.vector))))
        : 0;
      const sameSource = selected.some((chosen) => String(chosen.sourceId) === String(candidate.sourceId));
      const semanticPriority = candidate.semanticSimilarity + (candidate.answerCue ? ANSWER_CUE_BONUS : 0);
      const score = 0.86 * semanticPriority - 0.14 * redundancy - (sameSource ? 0.08 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const [chosen] = eligible.splice(bestIndex, 1);
    usedText.add(normalizeEvidenceText(chosen.text));
    selected.push(chosen);
  }
  return selected;
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
  queryVector,
  matches,
  threshold,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxLines = DEFAULT_MAX_LINES,
  baseUrl,
  model,
  formatVersion,
  embedTexts,
}) {
  const relevant = filterRelevantMatches(matches, threshold, { maxRecords });
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

  const inputs = passages.map((passage) => buildDocumentEmbeddingText('', passage.text, {
    model,
    formatVersion,
  }));
  const vectors = await embedInBatches(embedTexts, { baseUrl, model }, inputs);
  const candidates = passages.map((passage, index) => ({
    ...passage,
    vector: vectors[index],
    semanticSimilarity: cosineSimilarity(queryVector, vectors[index]),
  }));
  const selected = selectDiverseEvidence(candidates, maxLines);
  const allowedSources = new Set(relevantMatches.map((match) => String(match.sourceId)));
  const evidence = selected
    .filter((candidate) => (
      allowedSources.has(String(candidate.sourceId)) &&
      String(candidate.answer).includes(candidate.text)
    ))
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

  return {
    relevantMatches,
    summary: evidence.length ? {
      status: 'ready',
      mode: SUMMARY_MODE,
      text: evidence.map((item) => item.text).join('\n'),
      evidence,
      sourceCount: new Set(evidence.map((item) => String(item.sourceId))).size,
      candidateRecordCount: relevant.length,
      lineCount: evidence.length,
    } : {
      status: 'not_available',
      mode: SUMMARY_MODE,
      reason: 'no_semantically_relevant_passages',
      evidence: [],
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
  splitAnswerIntoPassages,
  cosineSimilarity,
  filterRelevantMatches,
  buildEvidencePassages,
  selectDiverseEvidence,
  buildSemanticSummary,
};
