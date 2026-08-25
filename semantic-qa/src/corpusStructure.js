const crypto = require('node:crypto');

const SWAMI_AUTHOR = 'Swami';
const MAX_RETRIEVAL_CHARACTERS = 1600;

const REPLY_MARKERS = [
  /(?:^|\n)\s*\[\s*repl(?:y|ies)\s+(?:of|by)\s+[^\]\n]{0,500}s[vw][aā]+m[iīy][^\]\n]{0,1500}\]\s*/giu,
  /(?:^|\n)\s*\[(?=[^\]\n]{0,2000}\bgiven\s+below\b)(?=[^\]\n]{0,2000}s[vw][aā]+m[iīy](?:['’]s)?\s+(?:response|reply|answer|explanation|clarification|discourse))[^\]\n]{1,2000}\]\s*/giu,
  /(?:^|\n)\s*\[\s*repl(?:y|ies)\s+to\s+(?:an?\s+|the\s+)?question\b[^\]\n]{0,2000}\]\s*/giu,
  /(?:^|\n)\s*\[(?=[^\]\n]{0,2000}(?:പ്രതികരണം|മറുപടി))(?=[^\]\n]{0,2000}സ്വാമി)[^\]\n]{1,2000}\]\s*/gu,
  /(?:^|\n|(?<=\]))\s*(?:(?:(?:Shri|Sri|Śrī)\s+)?(?:Datta\s*)?S[vw][aā]+m[iīy](?:ji)?(?:(?:\s+(?:re?r?plied|answered|responded|spoke|said|uv[aā]ca)(?:\s*\([^\n:]{1,100}\))?)|(?:['’]s\s+(?:reply|response|answer|comments?)))?|Answer|Reply)\s*(?::\s*-?|-)\s*/giu,
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
  /(?:^|\n)\s*(?:(?:Ms|Mrs|Mr|Dr|Prof)\.?\s+[^\n:]{1,100}|(?:Shri|Sri)\.?\s+[^\n:]{1,100}\s+(?:spoke|said|asked|comments?(?:\s+on[^\n:]*)?)|Mother(?:\s+of\s+[^\n:]{1,80})?|Father|Priest|Devotee|Questioner|Interviewer)\s*:\s*/giu,
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
  collect(REPLY_MARKERS, 'swami_reply');
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
  const rolePriority = { swami_reply: 0, devotee_question: 1, other_speaker: 2 };
  return events
    .sort((left, right) => left.start - right.start || rolePriority[left.role] - rolePriority[right.role] || left.contentStart - right.contentStart)
    .filter((event, index, values) => !index || event.start !== values[index - 1].start);
}

function parseAnswerUnits({ text: input, sourceId = '', sourceType = '', question = '', language = '', author = '' } = {}) {
  const text = String(input || '');
  const resolvedAuthor = String(author || '').trim() || SWAMI_AUTHOR;
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
        sourceId, answerUnitId: `${sourceId}:answer:1`, unitIndex: 1, unitKind: 'swami_reply', author: resolvedAuthor,
        associatedQuestion: String(question || '').trim(), language: String(language || ''),
        start: span.start, end: span.end, text: span.text, contextComplete: true, contentHash: sha256(span.text),
      });
    }
    return { units, ignored, ambiguities, author: resolvedAuthor };
  }

  if (!replyEvents.length) {
    if (otherSpeakerEvents.length || questionEvents.length) {
      ambiguities.push({
        sourceId,
        reason: 'speaker-marked discourse has no recognized Swami reply marker',
        offsets: [...questionEvents, ...otherSpeakerEvents].map((event) => event.start),
      });
      return { units, ignored, ambiguities, author: resolvedAuthor };
    }
    const span = trimRange(text, 0, text.length);
    if (span.text) {
      units.push({
        sourceId, answerUnitId: `${sourceId}:teaching:1`, unitIndex: 1, unitKind: 'swami_teaching', author: resolvedAuthor,
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
      sourceId, answerUnitId: `${sourceId}:reply:${unitIndex}`, unitIndex, unitKind: 'swami_reply', author: resolvedAuthor,
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
  if (sentences.length <= 1) return [citationSpan];
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
  return windows.filter((window) => window.text);
}

function buildAnswerPassages(text, units, { maxCharacters = MAX_RETRIEVAL_CHARACTERS } = {}) {
  const passages = [];
  for (const unit of units || []) {
    const logicalSpans = paragraphSpans(text, unit.start, unit.end)
      .flatMap((span) => stanzaSpans(text, span))
      .filter((span) => !nonCitableContextKind(span.text));
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
  const values = [record?.question, record?.metadata?.question_context, record?.metadata?.source_context]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const ignored of parsed?.ignored || []) values.push(String(ignored.text || '').trim());
  const displayText = String(record?.answer || '');
  for (const unit of parsed?.units || []) {
    for (const span of paragraphSpans(displayText, unit.start, unit.end)) {
      if (nonCitableContextKind(span.text)) values.push(span.text);
    }
  }
  return [...new Set(values)].map((text, index) => ({
    sourceId: String(record.sourceId), discoveryIndex: index, text,
  }));
}

module.exports = {
  MAX_RETRIEVAL_CHARACTERS,
  SWAMI_AUTHOR,
  buildAnswerPassages,
  buildDiscoveryTexts,
  markerEvents,
  nonCitableContextKind,
  parseAnswerUnits,
  sha256,
  storyCompleteness,
  trimRange,
};
