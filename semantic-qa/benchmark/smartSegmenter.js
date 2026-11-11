const crypto = require('node:crypto');

const SWAMI_AUTHOR = 'Swami';

// Recognized markers where Swami begins speaking or teaching
const REFINED_REPLY_MARKERS = [
  /(?:^|\n)\s*(?:Original\s+Message|New\s+Reply)\s+of\s+(?:(?:Shri|Sri|Śrī)\s+)?(?:Datta\s*)?S[vw][aā]+m[iīy](?:ji)?\s*(?::\s*-?|-)\s*/giu,
  /(?:^|\n)\s*Disciple\s+of\s+Datta\s*\(\s*Datta\s+S[vw][aā]+m[iīy]\s*\)\s+(?:spoke|said|re?r?plied|answered)\s*(?::\s*-?|-)\s*/giu,
  /(?:^|\n)\s*God-preacher\s+(?:(?:Shri|Sri|Śrī)\s+)?Datta\s+(?:spoke|said|re?r?plied|answered)\s*(?::\s*-?|-)\s*/giu, // In Gita chapters, Swami is referred to as God-preacher Shri Datta
  /(?:^|\n)\s*\[\s*repl(?:y|ies)\s+(?:of|by)\s+[^\]\n]{0,500}s[vw][aā]+m[iīy][^\]\n]{0,1500}\]\s*/giu,
  /(?:^|\n)\s*\[(?=[^\]\n]{0,2000}\bgiven\s+below\b)(?=[^\]\n]{0,2000}s[vw][aā]+m[iīy](?:['’]s)?\s+(?:response|reply|answer|explanation|clarification|discourse))[^\]\n]{1,2000}\]\s*/giu,
  /(?:^|\n)\s*\[(?=[^\]\n]{0,2000}\b(?:asked|question)\b)(?=[^\]\n]{0,2000}s[vw][aā]+m[iīy])(?=[^\]\n]{0,2000}\b(?:reply|answer|message)\b)[^\]\n]{1,2000}\]\s*/giu,
  /(?:^|\n)\s*\[\s*repl(?:y|ies)\s+to\s+(?:an?\s+|the\s+)?question\b[^\]\n]{0,2000}\]\s*/giu,
  /(?:^|\n)\s*\[(?=[^\]\n]{0,2000}(?:പ്രതികരണം|മറുപടി))(?=[^\]\n]{0,2000}സ്വാമി)[^\]\n]{1,2000}\]\s*/gu,
  /(?:^|\n|(?<=\]))\s*(?:(?:(?:Shri|Sri|Śrī)\s+)?(?:Datta\s*)?S[vw][aā]+m[iīy](?:ji)?(?:(?:\s+(?:re?r?plied|answered|responded|spoke|said|uv[aā]ca)(?:\s*\([^\n:]{1,100}\))?)|(?:['’]s\s+(?:reply|response|answer|comments?)))?|Answer|Reply)\s*(?::\s*-?|-)\s*/giu,
  /(?:^|\n|(?<=\]))\s*(?:(?:Shri|Sri|Śrī)\s+)?(?:Datta\s*)?S[vw][aā]+m[iīy](?:ji)?\s+(?:re?r?plied|answered|responded|spoke|said|uv[aā]ca)\b\s*(?=["'“”‘’\p{L}\p{N}])/giu,
  /(?:^|\n|(?<=\]))\s*(?:ശ്രീ\s*)?സ്വാമി\s*(?:മറുപടി\s*(?:പറഞ്ഞു|നൽകി)|ഉത്തരം\s*പറഞ്ഞു)?\s*(?::\s*-?|-)\s*/gu,
  /(?:^|\n|(?<=\]))\s*(?:శ్రీ\s*)?స్వామి\s*(?:సమాధానము|సమాధానం|జవాబు)?\s*(?::\s*-?|-)\s*/gu,
];

// Devotee questions
const REFINED_QUESTION_MARKERS = [
  /(?:^|\n)\s*\[?[^\n:\]]{1,120}\s+(?:asked|asks)\s*(?::\s*|-\s*)/giu,
  /(?:^|\n)\s*(?:Question|Q)\s*(?::\s*|-\s*)/giu,
  /(?:^|\n)\s*\[[^\]\n]{0,160}\b(?:question|asked)\b[^\]\n]{0,160}\]\s*/giu,
  /(?:^|\n)\s*\[?[^\n:\]]{1,120}\s+ചോദിച്ചു\s*(?::\s*|-\s*)/gu,
  /(?:^|\n)\s*\[[^\]\n]{0,200}ചോദ്യം[^\]\n]{0,200}\]\s*/gu,
  /(?:^|\n)\s*\[?[^\n:\]]{1,120}\s+(?:అడిగిన\s*ప్రశ్న|అడిగారు|ప్రశ్నించారు)\s*(?::\s*|-\s*)/gu,
  /(?:^|\n)\s*\[[^\]\n]{0,200}ప్రశ్న[^\]\n]{0,200}\]\s*/gu,
];

// Truly external non-Swami speakers
const REFINED_OTHER_SPEAKER_MARKERS = [
  /(?:^|\n)\s*\[\s*By\s+(?![^\]\n]{0,160}(?:s[vw][aā]+m[iīy]|datta))[^\]\n]{1,160}\]\s*/giu,
  /(?:^|\n)\s*(?:(?:Ms|Mrs|Mr|Dr|Prof)\.?\s+[^\n:]{1,100}|(?:Shri|Sri)\.?\s+(?!(?:Datta\s+)?S[vw][aā]+m[iīy]|Datta)[^\n:]{1,100}\s+(?:spoke|said|asked|comments?(?:\s+on[^\n:]*)?)|Mother(?:\s+of\s+[^\n:]{1,80})?|Father|Priest|Devotee|Questioner|Interviewer)\s*:\s*/giu,
  /(?:^|\n)\s*(?:ഫാദർ|പുരോഹിതൻ|ഭക്തൻ|ചോദ്യകർത്താവ്)\s*:\s*/gu,
  /(?:^|\n)\s*(?:ఫాదర్|భక్తుడు|ప్రశ్నకర్త)\s*:\s*/gu,
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function trimRange(text, rawStart, rawEnd) {
  let start = Math.max(0, Number(rawStart) || 0);
  let end = Math.min(text.length, Number(rawEnd) || text.length);
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return { start, end, text: text.slice(start, end) };
}

function markerEvents(text) {
  const events = [];
  const collect = (patterns, role) => {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const leadingBreak = match[0].startsWith('\n') ? 1 : 0;
        events.push({
          role,
          start: Number(match.index) + leadingBreak,
          contentStart: Number(match.index) + match[0].length,
          marker: match[0].trim(),
        });
      }
    }
  };
  collect(REFINED_REPLY_MARKERS, 'swami_reply');
  collect(REFINED_QUESTION_MARKERS, 'devotee_question');
  collect(REFINED_OTHER_SPEAKER_MARKERS, 'other_speaker');
  const rolePriority = { swami_reply: 0, devotee_question: 1, other_speaker: 2 };
  return events
    .sort((a, b) => a.start - b.start || rolePriority[a.role] - rolePriority[b.role] || a.contentStart - b.contentStart)
    .filter((event, index, values) => !index || event.start !== values[index - 1].start);
}

function parseAnswerUnits(doc) {
  const text = String(doc.display_text || doc.displayText || '');
  const sourceType = String(doc.source_type || doc.sourceType || '').toLowerCase();
  const sourceId = String(doc.document_id || doc.documentId || '');
  const docQuestion = String(doc.question_context || doc.title || '').trim();
  const language = String(doc.language || '');
  const author = String(doc.author || SWAMI_AUTHOR).trim() || SWAMI_AUTHOR;

  const units = [];
  const ignored = [];

  if (sourceType === 'qa') {
    const span = trimRange(text, 0, text.length);
    if (span.text) {
      units.push({
        sourceId,
        answerUnitId: `${sourceId}:answer:1`,
        unitIndex: 1,
        unitKind: 'swami_reply',
        author: SWAMI_AUTHOR,
        associatedQuestion: docQuestion,
        language,
        start: span.start,
        end: span.end,
        text: span.text,
        contentHash: sha256(span.text),
      });
    }
    return { units, ignored, author };
  }

  const events = markerEvents(text);
  const replyEvents = events.filter((e) => e.role === 'swami_reply');

  if (!replyEvents.length) {
    const paragraphs = paragraphSpans(text, 0, text.length);
    let questionParagraph = -1;
    for (let i = 0; i < Math.min(6, paragraphs.length - 1); i++) {
      if (/\?\s*$/u.test(paragraphs[i].text)) questionParagraph = i;
    }
    if (questionParagraph >= 0 && paragraphs[questionParagraph + 1]) {
      const qSpan = trimRange(text, 0, paragraphs[questionParagraph].end);
      const aSpan = trimRange(text, paragraphs[questionParagraph + 1].start, text.length);
      ignored.push({ role: 'devotee_question', start: qSpan.start, end: qSpan.end, text: qSpan.text });
      if (aSpan.text) {
        units.push({
          sourceId,
          answerUnitId: `${sourceId}:reply:1`,
          unitIndex: 1,
          unitKind: 'swami_reply',
          author: SWAMI_AUTHOR,
          associatedQuestion: qSpan.text,
          language,
          start: aSpan.start,
          end: aSpan.end,
          text: aSpan.text,
          contentHash: sha256(aSpan.text),
        });
      }
      return { units, ignored, author };
    }

    const span = trimRange(text, 0, text.length);
    if (span.text) {
      units.push({
        sourceId,
        answerUnitId: `${sourceId}:teaching:1`,
        unitIndex: 1,
        unitKind: 'swami_teaching',
        author: SWAMI_AUTHOR,
        associatedQuestion: docQuestion,
        language,
        start: span.start,
        end: span.end,
        text: span.text,
        contentHash: sha256(span.text),
      });
    }
    return { units, ignored, author };
  }

  const boundaries = events.filter((e) => ['swami_reply', 'devotee_question', 'other_speaker'].includes(e.role));
  let lastQuestion = docQuestion;

  for (let i = 0; i < boundaries.length; i++) {
    const event = boundaries[i];
    const next = boundaries[i + 1];
    const span = trimRange(text, event.contentStart, next?.start ?? text.length);
    if (!span.text) continue;

    if (event.role === 'devotee_question') {
      lastQuestion = span.text;
      ignored.push({ role: event.role, start: span.start, end: span.end, text: span.text });
      continue;
    }
    if (event.role === 'other_speaker') {
      ignored.push({ role: event.role, start: span.start, end: span.end, text: span.text });
      continue;
    }

    const unitIndex = units.length + 1;
    units.push({
      sourceId,
      answerUnitId: `${sourceId}:reply:${unitIndex}`,
      unitIndex,
      unitKind: 'swami_reply',
      author: SWAMI_AUTHOR,
      associatedQuestion: lastQuestion,
      language,
      start: span.start,
      end: span.end,
      text: span.text,
      contentHash: sha256(span.text),
    });
  }

  return { units, ignored, author };
}

function paragraphSpans(text, start, end) {
  const spans = [];
  const body = text.slice(start, end);
  const separator = /\r?\n[ \t]*\r?\n/gu;
  let cursor = 0;
  let match;
  while ((match = separator.exec(body))) {
    const span = trimRange(text, start + cursor, start + match.index);
    if (span.text) spans.push(span);
    cursor = match.index + match[0].length;
  }
  const tail = trimRange(text, start + cursor, end);
  if (tail.text) spans.push(tail);
  return spans;
}

function sentenceSpans(text, start, end) {
  const body = text.slice(start, end);
  const spans = [];
  const regex = /[^.!?।|\n]+(?:[.!?।|\n]+|(?=\n|$))/gu;
  let match;
  while ((match = regex.exec(body))) {
    const s = trimRange(text, start + match.index, start + match.index + match[0].length);
    if (s.text) spans.push(s);
  }
  if (!spans.length) {
    const fallback = trimRange(text, start, end);
    if (fallback.text) spans.push(fallback);
  }
  return spans;
}

function isOrphanFragment(text) {
  const t = text.trim();
  if (t.length <= 15) return true;
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true;
  if (/^(?:keywords|chapter|section|part|verse|sloka|sutra)[\s\d:–-]+$/iu.test(t)) return true;
  if (/^•\s*[\p{L}\d]{1,25}$/u.test(t)) return true;
  if (t.length < 90 && !/[.!?।|]$/u.test(t) && !/\n/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Smart segmentation that merges orphan fragments into surrounding context,
 * windows oversized paragraphs, and targets 300 - 800 character windows.
 */
function segmentAnswerUnit(unit, fullDocText, { minTarget = 250, maxTarget = 850 } = {}) {
  const rawParagraphs = paragraphSpans(fullDocText, unit.start, unit.end);
  if (!rawParagraphs.length) return [];

  // Step 1: Pre-split any massive unbroken paragraphs (>1000 chars) into sentence groups
  const normalizedSpans = [];
  for (const para of rawParagraphs) {
    if (para.text.length <= maxTarget * 1.3) {
      normalizedSpans.push(para);
    } else {
      const sentences = sentenceSpans(fullDocText, para.start, para.end);
      let chunkStart = sentences[0]?.start ?? para.start;
      let chunkEnd = sentences[0]?.end ?? para.end;

      for (let sIdx = 1; sIdx < sentences.length; sIdx++) {
        const s = sentences[sIdx];
        if (s.end - chunkStart > maxTarget) {
          normalizedSpans.push(trimRange(fullDocText, chunkStart, chunkEnd));
          chunkStart = s.start;
        }
        chunkEnd = s.end;
      }
      normalizedSpans.push(trimRange(fullDocText, chunkStart, chunkEnd));
    }
  }

  // Step 2: Fuse orphan fragments (equations, bullet words, subheadings)
  const fusedSpans = [];
  let pendingFragment = null;

  for (let i = 0; i < normalizedSpans.length; i++) {
    const current = normalizedSpans[i];
    if (isOrphanFragment(current.text)) {
      if (pendingFragment) {
        pendingFragment = {
          start: pendingFragment.start,
          end: current.end,
          text: fullDocText.slice(pendingFragment.start, current.end).trim(),
        };
      } else {
        pendingFragment = current;
      }
    } else {
      if (pendingFragment) {
        fusedSpans.push({
          start: pendingFragment.start,
          end: current.end,
          text: fullDocText.slice(pendingFragment.start, current.end).trim(),
        });
        pendingFragment = null;
      } else {
        fusedSpans.push(current);
      }
    }
  }

  if (pendingFragment) {
    if (fusedSpans.length > 0) {
      const last = fusedSpans[fusedSpans.length - 1];
      fusedSpans[fusedSpans.length - 1] = {
        start: last.start,
        end: pendingFragment.end,
        text: fullDocText.slice(last.start, pendingFragment.end).trim(),
      };
    } else {
      fusedSpans.push(pendingFragment);
    }
  }

  // Step 3: Combine adjacent short spans up to target window
  const passages = [];
  let accumulator = null;

  for (const span of fusedSpans) {
    if (!accumulator) {
      accumulator = span;
      continue;
    }

    const combinedLen = span.end - accumulator.start;
    if (combinedLen <= maxTarget && (accumulator.text.length < minTarget || span.text.length < minTarget)) {
      accumulator = {
        start: accumulator.start,
        end: span.end,
        text: fullDocText.slice(accumulator.start, span.end).trim(),
      };
    } else {
      passages.push(accumulator);
      accumulator = span;
    }
  }
  if (accumulator) {
    if (passages.length > 0 && accumulator.text.length < minTarget && (accumulator.end - passages[passages.length - 1].start) <= (maxTarget * 1.3)) {
      const prev = passages.pop();
      passages.push({
        start: prev.start,
        end: accumulator.end,
        text: fullDocText.slice(prev.start, accumulator.end).trim(),
      });
    } else {
      passages.push(accumulator);
    }
  }

  return passages.map((p, idx) => ({
    sourceId: unit.sourceId,
    answerUnitId: unit.answerUnitId,
    passageIndex: idx,
    unitKind: unit.unitKind,
    associatedQuestion: unit.associatedQuestion || '',
    text: p.text,
    startOffset: p.start,
    endOffset: p.end,
    charLength: p.text.length,
  }));
}

function truncateContext(text, maxChars = 350) {
  const t = String(text || '').trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + '...';
}

function buildContextualEmbeddingText(passage, docTitle, modelType = 'embeddinggemma') {
  const title = String(docTitle || '').trim();
  const rawQ = String(passage.associatedQuestion || '').trim();
  const question = truncateContext(rawQ, 350); // Bound devotee question context
  const text = String(passage.text || '').trim();

  if (modelType === 'embeddinggemma') {
    const contextPart = question ? ` (Question: ${question})` : '';
    return `title: ${title}${contextPart} | text: ${text}`;
  }

  if (modelType === 'bge-m3') {
    const header = [title, question].filter(Boolean).join(' — ');
    return header ? `${header}\n\n${text}` : text;
  }

  return text;
}

function buildQueryEmbeddingText(query, modelType = 'embeddinggemma') {
  const q = String(query || '').trim();
  if (modelType === 'embeddinggemma') {
    return `task: question answering | query: ${q}`;
  }
  return q;
}

module.exports = {
  parseAnswerUnits,
  segmentAnswerUnit,
  buildContextualEmbeddingText,
  buildQueryEmbeddingText,
  isOrphanFragment,
};
