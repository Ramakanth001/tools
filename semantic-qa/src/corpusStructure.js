const crypto = require('node:crypto');

const SWAMI_AUTHOR = 'Swami';
const MAX_RETRIEVAL_CHARACTERS = 1600;
const TARGET_PASSAGE_MIN = 250;
const TARGET_PASSAGE_MAX = 800;

const REPLY_MARKERS = [
  /(?:^|\n)\s*(?:Original\s+Message|New\s+Reply)\s+of\s+(?:(?:Shri|Sri|Śrī)\s+)?(?:Datta\s*)?S[vw][aā]+m[iīy](?:ji)?\s*(?::\s*-?|-)\s*/giu,
  /(?:^|\n)\s*Disciple\s+of\s+Datta\s*\(\s*Datta\s+S[vw][aā]+m[iīy]\s*\)\s+(?:spoke|said|re?r?plied|answered)\s*(?::\s*-?|-)\s*/giu,
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

const QUESTION_MARKERS = [
  /(?:^|\n)\s*\[?[^\n:\]]{1,120}\s+(?:asked|asks)\s*(?::\s*|-\s*)/giu,
  /(?:^|\n)\s*(?:Question|Q)\s*(?::\s*|-\s*)/giu,
  /(?:^|\n)\s*\[[^\]\n]{0,160}\b(?:question|asked)\b[^\]\n]{0,160}\]\s*/giu,
  /(?:^|\n)\s*\[?[^\n:\]]{1,120}\s+ചോദിച്ചു\s*(?::\s*|-\s*)/gu,
  /(?:^|\n)\s*\[[^\]\n]{0,200}ചോദ്യം[^\]\n]{0,200}\]\s*/gu,
  /(?:^|\n)\s*\[?[^\n:\]]{1,120}\s+(?:అడిగిన\s*ప్రశ్న|అడిగారు|ప్రశ్నించారు)\s*(?::\s*|-\s*)/gu,
  /(?:^|\n)\s*\[[^\]\n]{0,200}ప్రశ్న[^\]\n]{0,200}\]\s*/gu,
];

const NON_SWAMI_SPEAKER_MARKERS = [
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
  const hasDiscipleOfDatta = /(?:^|\n)\s*Disciple\s+of\s+Datta/iu.test(text);
  const godPreacherMarker = /(?:^|\n)\s*God-preacher\s+(?:(?:Shri|Sri|Śrī)\s+)?Datta\s+(?:spoke|said|re?r?plied|answered)\s*(?::\s*-?|-)\s*/giu;

  collect(REPLY_MARKERS, 'swami_reply');
  if (!hasDiscipleOfDatta) {
    collect([godPreacherMarker], 'swami_reply');
  }
  for (const reply of events.filter((event) => event.role === 'swami_reply')) {
    const lookbackStart = Math.max(0, reply.start - 7000);
    const beforeReply = text.slice(lookbackStart, reply.start);
    const match = beforeReply.match(/(?:^|\n[ \t]*\n)([ \t]*(?:\d+[a-z]?|[a-z])[.)][ \t]+[^\r\n]{3,1800}\?[ \t]*(?:\r?\n[ \t]*\r?\n[ \t]*\[[^\]]{0,5000}\])?[ \t\r\n]*)$/iu);
    if (!match?.[1]) continue;
    const relativeStart = Number(match.index) + match[0].indexOf(match[1]);
    const start = lookbackStart + relativeStart;
    events.push({
      role: 'devotee_question',
      start,
      contentStart: start,
      marker: match[1].match(/^\s*(?:\d+[a-z]?|[a-z])[.)]/iu)?.[0]?.trim() || 'numbered question',
    });
  }
  collect(QUESTION_MARKERS, 'devotee_question');
  collect(NON_SWAMI_SPEAKER_MARKERS, 'other_speaker');
  if (hasDiscipleOfDatta) {
    collect([godPreacherMarker], 'other_speaker');
  }
  const rolePriority = { swami_reply: 0, devotee_question: 1, other_speaker: 2 };
  return events
    .sort((left, right) => left.start - right.start || rolePriority[left.role] - rolePriority[right.role] || left.contentStart - right.contentStart)
    .filter((event, index, values) => !index || event.start !== values[index - 1].start);
}

function explicitByline(text) {
  return String(text || '').match(/^\s*\[By\s+([^\]\r\n]+)\]/iu)?.[1]?.trim() || '';
}

function isCitableSwamiUnit(unit) {
  const byline = explicitByline(unit.text) || (unit.unitKind !== 'swami_reply' ? explicitByline(unit.displayText) : '');
  return unit.author === SWAMI_AUTHOR && (!byline || /^(?:(?:Shri|Sri)\s+)?(?:Datta\s*Swami|Swami)$/iu.test(byline));
}

function parseAnswerUnits({ text: input, sourceId = '', sourceType = '', question = '', language = '', author = '' } = {}) {
  const text = String(input || '');
  const resolvedAuthor = explicitByline(text) || String(author || '').trim() || SWAMI_AUTHOR;
  const events = markerEvents(text);
  const replyEvents = events.filter((event) => event.role === 'swami_reply');
  const questionEvents = events.filter((event) => event.role === 'devotee_question');
  const otherSpeakerEvents = events.filter((event) => event.role === 'other_speaker');
  const units = [];
  const ignored = [];
  const ambiguities = [];

  if (String(sourceType).toLowerCase() === 'qa') {
    const span = trimRange(text, 0, text.length);
    if (span.text) {
      units.push({
        sourceId, answerUnitId: `${sourceId}:answer:1`, unitIndex: 1, unitKind: 'swami_reply', author: SWAMI_AUTHOR,
        associatedQuestion: String(question || '').trim(), language: String(language || ''),
        start: span.start, end: span.end, text: span.text, contextComplete: true, contentHash: sha256(span.text),
      });
    }
    return { units, ignored, ambiguities, author: resolvedAuthor };
  }

  if (!replyEvents.length) {
    if (resolvedAuthor !== SWAMI_AUTHOR && !isCitableSwamiUnit({ author: SWAMI_AUTHOR, text })) {
      ignored.push({ role: 'other_speaker', start: 0, end: text.length, text });
      ambiguities.push({ sourceId, reason: 'explicit non-Swami byline has no recognized Swami reply', offsets: [0] });
      return { units, ignored, ambiguities, author: resolvedAuthor };
    }
    if (resolvedAuthor !== SWAMI_AUTHOR && !explicitByline(text)) {
      ignored.push({ role: 'other_speaker', start: 0, end: text.length, text });
      return { units, ignored, ambiguities, author: resolvedAuthor };
    }
    if (otherSpeakerEvents.length) {
      ambiguities.push({
        sourceId,
        reason: 'speaker-marked discourse has no recognized Swami reply marker',
        offsets: otherSpeakerEvents.map((event) => event.start),
      });
      return { units, ignored, ambiguities, author: resolvedAuthor };
    }
    const paragraphs = paragraphSpans(text, 0, text.length);
    const leadingLimit = Math.min(8, paragraphs.length - 1);
    let questionParagraph = -1;
    for (let index = 0; index < leadingLimit; index += 1) {
      const paragraph = paragraphs[index];
      if (paragraph.start > 7000) break;
      if (/\?\s*(?:\]|["'”’])?\s*$/u.test(paragraph.text)) questionParagraph = index;
    }
    if (questionEvents.length && questionParagraph >= 0 && paragraphs[questionParagraph + 1]) {
      const answer = trimRange(text, paragraphs[questionParagraph + 1].start, text.length);
      const context = trimRange(text, 0, paragraphs[questionParagraph + 1].start);
      if (context.text) ignored.push({ role: 'devotee_question', start: context.start, end: context.end, text: context.text });
      if (answer.text) {
        units.push({
          sourceId, answerUnitId: `${sourceId}:reply:1`, unitIndex: 1, unitKind: 'swami_reply', author: SWAMI_AUTHOR,
          associatedQuestion: paragraphs[questionParagraph].text, language: String(language || ''),
          start: answer.start, end: answer.end, text: answer.text, contextComplete: true, contentHash: sha256(answer.text),
        });
      }
      return { units, ignored, ambiguities, author: resolvedAuthor };
    }
    const span = trimRange(text, 0, text.length);
    if (span.text) {
      units.push({
        sourceId, answerUnitId: `${sourceId}:teaching:1`, unitIndex: 1, unitKind: 'swami_teaching', author: SWAMI_AUTHOR,
        associatedQuestion: String(question || '').trim(), language: String(language || ''),
        start: span.start, end: span.end, text: span.text, contextComplete: true, contentHash: sha256(span.text),
      });
    }
    return { units, ignored, ambiguities, author: resolvedAuthor };
  }

  const boundaries = events.filter((event) => ['swami_reply', 'devotee_question', 'other_speaker'].includes(event.role));
  let lastQuestion = String(question || '').trim();
  for (let index = 0; index < boundaries.length; index += 1) {
    const event = boundaries[index];
    const next = boundaries[index + 1];
    const span = trimRange(text, event.contentStart, next?.start ?? text.length);
    if (!span.text) continue;
    if (event.role === 'devotee_question') {
      const questionText = span.text.trim();
      const bracketed = questionText.endsWith(']') && (questionText.startsWith('[') || String(event.marker || '').startsWith('['));
      lastQuestion = (bracketed
        ? questionText.slice(questionText.startsWith('[') ? 1 : 0, -1).trim()
        : questionText) || lastQuestion;
      ignored.push({ role: event.role, start: span.start, end: span.end, text: span.text });
      continue;
    }
    if (event.role === 'other_speaker') {
      ignored.push({ role: event.role, start: span.start, end: span.end, text: span.text });
      continue;
    }
    const unitIndex = units.length + 1;
    units.push({
      sourceId, answerUnitId: `${sourceId}:reply:${unitIndex}`, unitIndex, unitKind: 'swami_reply', author: SWAMI_AUTHOR,
      associatedQuestion: lastQuestion, language: String(language || ''),
      start: span.start, end: span.end, text: span.text, contextComplete: true, contentHash: sha256(span.text),
    });
  }
  if (!units.length) ambiguities.push({ sourceId, reason: 'reply markers were found but no complete Swami reply text was produced', offsets: replyEvents.map((event) => event.start) });
  return { units, ignored, ambiguities, author: resolvedAuthor };
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
  const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
  const spans = segmenter
    ? [...segmenter.segment(body)].map((segment) => trimRange(text, start + segment.index, start + segment.index + segment.segment.length))
    : [...body.matchAll(/[^.!?。！？\n]+(?:[.!?。！？]+|(?=\n|$))|\n+/gu)]
      .map((match) => trimRange(text, start + Number(match.index), start + Number(match.index) + match[0].length));
  return spans.filter((span) => span.text);
}

function stanzaSpans(text, span) {
  const lines = [...span.text.matchAll(/[^\r\n]+/gu)]
    .map((match) => trimRange(text, span.start + Number(match.index), span.start + Number(match.index) + match[0].length))
    .filter((line) => line.text);
  if (lines.length < 4 || /[.!?。！？]/u.test(span.text)) return [span];
  const grouped = [];
  for (let index = 0; index < lines.length; index += 4) {
    grouped.push(trimRange(text, lines[index].start, lines[Math.min(lines.length - 1, index + 3)].end));
  }
  return grouped;
}

function hardCharacterWindows(text, span, maxCharacters) {
  if (span.end - span.start <= maxCharacters) return [span];
  const windows = [];
  const overlap = Math.min(160, Math.floor(maxCharacters / 8));
  let cursor = span.start;
  while (cursor < span.end) {
    let end = Math.min(span.end, cursor + maxCharacters);
    if (end < span.end) {
      const candidate = text.slice(cursor + Math.floor(maxCharacters * 0.7), end);
      const boundary = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\n'), candidate.lastIndexOf('\t'));
      if (boundary >= 0) end = cursor + Math.floor(maxCharacters * 0.7) + boundary;
    }
    const window = trimRange(text, cursor, end);
    if (window.text) windows.push(window);
    if (end >= span.end) break;
    const next = Math.max(cursor + 1, end - overlap);
    const leading = text.slice(next, Math.min(end, next + overlap)).search(/\s/u);
    cursor = leading >= 0 ? next + leading + 1 : next;
  }
  return windows;
}

function nonCitableContextKind(value) {
  const text = String(value || '').trim();
  if (!text) return 'empty';
  if (/^\[?\s*(?:(?:translator(?:'s|’s)?|translation|editor(?:'s|’s)?)\s+note\s*:|translated\s+by\b)/iu.test(text)) return 'translator_note';
  if (/^#{1,6}\s+\S/u.test(text)) return 'heading';
  if (text.length <= 240 && /^(?:\d+|[ivxlcdm]+)[.)]\s+[^\n]+(?::\s*-?|-)\s*$/iu.test(text)) return 'heading';
  if (text.length <= 180 && /^[^\n.!?。！？]{2,160}(?::\s*-|:-)\s*$/u.test(text)) return 'heading';
  return null;
}

function retrievalWindows(text, citationSpan, maxCharacters = MAX_RETRIEVAL_CHARACTERS) {
  if (citationSpan.text.length <= maxCharacters) return [citationSpan];
  const sentences = sentenceSpans(text, citationSpan.start, citationSpan.end);
  if (sentences.length <= 1) return hardCharacterWindows(text, citationSpan, maxCharacters);
  const windows = [];
  let currentStart = sentences[0].start;
  let currentEnd = sentences[0].end;
  for (let index = 1; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    if (sentence.end - currentStart > maxCharacters) {
      windows.push(trimRange(text, currentStart, currentEnd));
      currentStart = sentence.start;
    }
    currentEnd = sentence.end;
  }
  windows.push(trimRange(text, currentStart, currentEnd));
  return windows
    .filter((window) => window.text)
    .flatMap((window) => hardCharacterWindows(text, window, maxCharacters));
}

function isOrphanFragment(text) {
  const t = String(text || '').trim();
  if (t.length < 25) return true;
  if (!/[.!?。！？।]['"”’\)\]]*$/u.test(t) && t.length < 120) return true;
  return false;
}

function mergeOrphanLogicalSpans(text, spans, maxCharacters = MAX_RETRIEVAL_CHARACTERS) {
  if (spans.length <= 1) return spans;
  const merged = [];
  let current = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const next = spans[i];
    const gap = text.slice(current.end, next.start);
    const combinedLength = next.end - current.start;
    if (/^\s*$/.test(gap) && (isOrphanFragment(current.text) || isOrphanFragment(next.text)) && combinedLength <= maxCharacters) {
      current = trimRange(text, current.start, next.end);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

function mergeCohesiveParagraphSpans(text, spans, maxCharacters = MAX_RETRIEVAL_CHARACTERS) {
  if (spans.length <= 1) return spans;
  const orphanMerged = mergeOrphanLogicalSpans(text, spans, maxCharacters);
  if (orphanMerged.length <= 1) return orphanMerged;

  const merged = [];
  let current = orphanMerged[0];
  for (let i = 1; i < orphanMerged.length; i++) {
    const next = orphanMerged[i];
    const gap = text.slice(current.end, next.start);
    const combinedLength = next.end - current.start;
    const isContiguous = /^\s*$/.test(gap);
    const isShortParagraph = current.text.length < TARGET_PASSAGE_MIN || next.text.length < TARGET_PASSAGE_MIN;
    const canMergeTarget = combinedLength <= TARGET_PASSAGE_MAX && combinedLength <= maxCharacters;

    if (isContiguous && canMergeTarget && (isShortParagraph || combinedLength <= 500)) {
      current = trimRange(text, current.start, next.end);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

function buildAnswerPassages(text, units, { maxCharacters = MAX_RETRIEVAL_CHARACTERS } = {}) {
  const passages = [];
  for (const unit of units || []) {
    const rawSpans = paragraphSpans(text, unit.start, unit.end)
      .flatMap((span) => stanzaSpans(text, span))
      .filter((span) => !nonCitableContextKind(span.text));
    const logicalSpans = mergeCohesiveParagraphSpans(text, rawSpans, maxCharacters);
    for (const citation of logicalSpans) {
      for (const window of retrievalWindows(text, citation, maxCharacters)) {
        passages.push({
          sourceId: String(unit.sourceId || ''),
          answerUnitId: unit.answerUnitId,
          passageIndex: passages.length,
          text: window.text,
          start: window.start,
          end: window.end,
          citationStart: citation.start,
          citationEnd: citation.end,
          citationText: citation.text,
          author: unit.author,
          unitKind: unit.unitKind,
          associatedQuestion: unit.associatedQuestion,
          contextComplete: unit.contextComplete,
          storyComplete: storyCompleteness(citation.text),
        });
      }
    }
  }
  return passages;
}

function storyCompleteness(value) {
  const text = String(value || '');
  const storySignal = /\b(?:once|story|incident|happened|went to|came to|there lived|there was|one day|one such|a (?:man|person|fellow|devotee)\b)/iu;
  if (!storySignal.test(text)) return true;
  return /\b(?:therefore|thus|hence|lesson|moral|so you should|this shows|this means|consequence|result)\b/iu.test(text);
}

function buildDiscoveryTexts(record, parsed = null) {
  const items = [];
  const add = (text, answerUnitId = null, kind = 'context') => {
    const clean = String(text || '').trim();
    if (clean && !items.some((i) => i.text === clean && i.answerUnitId === answerUnitId && i.kind === kind)) {
      items.push({ text: clean, answerUnitId, kind });
    }
  };
  const isMultiUnit = (parsed?.units?.length || 0) > 1;
  const singleUnitId = (!isMultiUnit && parsed?.units?.[0]?.answerUnitId) || null;
  if (record?.question) add(record.question, null, 'title');
  const isQa = record?.metadata?.source_type === 'qa';
  if (record?.metadata?.question_context) add(record.metadata.question_context, singleUnitId, isQa ? 'paired_question' : 'context');
  if (record?.metadata?.source_context) add(record.metadata.source_context, null);
  for (const unit of parsed?.units || []) {
    if (unit.associatedQuestion) {
      const hasParsedQuestion = (parsed?.ignored || []).some((item) => item.role === 'devotee_question' &&
        (item.text.includes(unit.associatedQuestion) || unit.associatedQuestion.includes(item.text)));
      add(unit.associatedQuestion, unit.answerUnitId, isQa || hasParsedQuestion ? 'paired_question' : 'context');
    }
    const displayText = String(record?.answer || '');
    for (const span of paragraphSpans(displayText, unit.start, unit.end)) {
      if (nonCitableContextKind(span.text)) add(span.text, unit.answerUnitId);
    }
  }
  for (const ignored of parsed?.ignored || []) {
    let matchedUnitId = null;
    const ignoredText = String(ignored.text || '').trim();
    if (parsed?.units) {
      const match = parsed.units.find((u) => u.associatedQuestion && (
        u.associatedQuestion.includes(ignoredText) || ignoredText.includes(u.associatedQuestion)
      ));
      if (match) {
        matchedUnitId = match.answerUnitId;
      } else {
        const nextUnit = parsed.units.find((u) => u.start >= ignored.end);
        if (nextUnit) matchedUnitId = nextUnit.answerUnitId;
      }
    }
    add(ignored.text, matchedUnitId || singleUnitId,
      ignored.role === 'devotee_question' ? 'paired_question' : 'context');
  }
  const windows = [];
  for (const item of items) {
    const span = trimRange(item.text, 0, item.text.length);
    for (const window of retrievalWindows(item.text, span)) {
      if (window.text) windows.push({ text: window.text, answerUnitId: item.answerUnitId, kind: item.kind });
    }
  }
  const seen = new Map();
  for (const w of windows) {
    const key = JSON.stringify([w.text, w.answerUnitId, w.kind]);
    if (!seen.has(key)) {
      seen.set(key, w);
    }
  }
  const unique = Array.from(seen.values());
  return unique.map((item, index) => ({
    sourceId: String(record.sourceId),
    discoveryIndex: index,
    text: item.text,
    answerUnitId: item.answerUnitId || null,
    kind: item.kind,
  }));
}

module.exports = {
  explicitByline,
  isCitableSwamiUnit,
  MAX_RETRIEVAL_CHARACTERS,
  SWAMI_AUTHOR,
  TARGET_PASSAGE_MIN,
  TARGET_PASSAGE_MAX,
  buildAnswerPassages,
  buildDiscoveryTexts,
  hardCharacterWindows,
  markerEvents,
  mergeCohesiveParagraphSpans,
  mergeOrphanLogicalSpans,
  nonCitableContextKind,
  parseAnswerUnits,
  sha256,
  storyCompleteness,
  trimRange,
};
