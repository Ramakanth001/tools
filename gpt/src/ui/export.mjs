function clean(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function escapeHtml(value) {
  return clean(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

function exportSources(message) {
  return [...(message?.sources || [])]
    .filter((source) => clean(source.excerpt))
    .sort((left, right) => Number(left.citationNumber || 0) - Number(right.citationNumber || 0));
}

function sourceLocation(source = {}) {
  const locator = source.locator || {};
  const metadata = source.metadata || {};
  const parts = [
    locator.book || metadata.book,
    locator.chapter || metadata.chapter,
    locator.page || metadata.page,
    locator.section || metadata.section,
  ].filter((value) => value !== undefined && value !== null && String(value).trim());
  return parts.map(clean).join(' · ');
}

function sourceDetails(source = {}) {
  const metadata = source.metadata || {};
  const details = [];
  const location = sourceLocation(source);
  if (metadata.source_type) details.push(`Type: ${clean(metadata.source_type)}`);
  if (metadata.record_date) details.push(`Date: ${clean(metadata.record_date)}`);
  if (location) details.push(`Location: ${location}`);
  if (source.sourceId) details.push(`Source ID: ${clean(source.sourceId)}`);
  if (Number.isInteger(Number(source.passageIndex))) details.push(`Passage: ${Number(source.passageIndex)}`);
  if (Number.isInteger(Number(source.start)) && Number.isInteger(Number(source.end))) {
    details.push(`Exact span: characters ${Number(source.start)}–${Number(source.end)}`);
  }
  return details;
}

function quoteMarkdown(value) {
  return clean(value).split('\n').map((line) => `> ${line}`).join('\n');
}

function excerptLabel(source = {}) {
  return source.adjudication?.verbatim ? 'Exact answer from corpus' : 'Exact cited excerpt';
}

function inlineHtml(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/gu, '<code>$1</code>')
    .replace(/\[(\d+)\]/gu, '<sup class="citation">[$1]</sup>');
}

function markdownBlocksHtml(value) {
  const lines = clean(value).split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      blocks.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`); index += 1; continue;
    }
    if (/^\s*[-*]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/u.test(lines[index])) items.push(`<li>${inlineHtml(lines[index++].replace(/^\s*[-*]\s+/u, ''))}</li>`);
      blocks.push(`<ul>${items.join('')}</ul>`); continue;
    }
    if (/^\s*\d+[.)]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index])) items.push(`<li>${inlineHtml(lines[index++].replace(/^\s*\d+[.)]\s+/u, ''))}</li>`);
      blocks.push(`<ol>${items.join('')}</ol>`); continue;
    }
    if (/^>\s?/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/u.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/u, ''));
      blocks.push(`<blockquote>${inlineHtml(quote.join('\n')).replace(/\n/gu, '<br>')}</blockquote>`); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^\s*[-*]\s+|^\s*\d+[.)]\s+|^>/u.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(`<p>${inlineHtml(paragraph.join('\n')).replace(/\n/gu, '<br>')}</p>`);
  }
  return blocks.join('\n');
}

function citationHtml(source, index) {
  const number = Number(source.citationNumber) || index + 1;
  const details = sourceDetails(source);
  return `<article class="source">
    <h3><span class="source-number">[${number}]</span> ${escapeHtml(source.title) || 'Corpus source'}</h3>
    ${details.length ? `<ul class="metadata">${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join('')}</ul>` : ''}
    <div class="excerpt-label">${excerptLabel(source)}</div>
    <blockquote>${escapeHtml(source.excerpt).replace(/\n/gu, '<br>')}</blockquote>
  </article>`;
}

function documentCss() {
  return `
    @page { size: A4; margin: 18mm 17mm 20mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172033; background: #fff; font: 11pt/1.58 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; }
    main { max-width: 760px; margin: 0 auto; }
    header { margin: 0 0 28px; padding-bottom: 16px; border-bottom: 2px solid #6046c7; }
    .kicker { color: #6046c7; font-size: 9pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 6px 0 0; color: #111827; font-size: 24pt; line-height: 1.2; }
    h2 { margin: 28px 0 12px; color: #20164d; font-size: 16pt; }
    h3 { margin: 0 0 8px; color: #172033; font-size: 12.5pt; line-height: 1.35; }
    p { margin: 0 0 12px; }
    ul, ol { margin: 8px 0 14px; padding-left: 24px; }
    code { padding: 1px 4px; border-radius: 3px; background: #f1effa; }
    .citation { color: #3b5ccc; font-size: 8.5pt; font-weight: 700; }
    .citation-note { margin: 0 0 18px; color: #687083; font-size: 9.5pt; }
    .chat-turn { margin: 0 0 32px; padding: 0 0 24px; border-bottom: 1px solid #d9deea; }
    .chat-turn:last-child { border-bottom: 0; }
    .turn-number { margin-bottom: 6px; color: #6046c7; font-size: 9pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .question { margin: 0 0 18px; padding: 12px 14px; break-inside: avoid; border-radius: 6px; background: #f1effa; }
    .question h2, .answer-block h2 { margin-top: 0; }
    .answer-block + .answer-block { margin-top: 28px; padding-top: 22px; border-top: 1px dashed #c8cfdd; }
    .answer-version { margin: -6px 0 12px; color: #687083; font-size: 9pt; }
    .answer-citations { margin-top: 20px; }
    .source { margin: 0 0 20px; padding: 14px 15px; break-inside: avoid; border: 1px solid #d9deea; border-left: 4px solid #5b75d6; border-radius: 5px; }
    .source-number { color: #3b5ccc; }
    .metadata { display: block; margin: 0 0 10px; padding: 0; color: #5d6678; font-size: 8.5pt; list-style: none; }
    .metadata li { display: inline; }
    .metadata li + li::before { content: " • "; color: #9aa2b1; }
    .excerpt-label { margin: 8px 0 5px; color: #3b5ccc; font-size: 8.5pt; font-weight: 700; text-transform: uppercase; }
    blockquote { margin: 0; padding: 10px 12px; background: #f7f8fc; color: #30394b; white-space: normal; }
    @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  `;
}

export function questionForMessage(messages, messageIndex) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = Math.min(Number(messageIndex) - 1, list.length - 1); index >= 0; index -= 1) {
    if (list[index]?.role === 'user' && clean(list[index]?.content)) return clean(list[index].content);
  }
  return '';
}

export function conversationTurns(messages) {
  const turns = [];
  let currentTurn = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'user') {
      currentTurn = { question: clean(message.content), userMessage: message, answers: [] };
      turns.push(currentTurn);
    } else if (message?.role === 'assistant') {
      if (!currentTurn) {
        currentTurn = { question: '', userMessage: null, answers: [] };
        turns.push(currentTurn);
      }
      currentTurn.answers.push(message);
    }
  }
  return turns.filter((turn) => turn.question || turn.answers.length);
}

export function answerExportMarkdown({ title, message }) {
  const answer = clean(message?.content);
  const sources = exportSources(message);
  const sections = [`# ${clean(title) || 'GPT corpus answer'}`, '', answer];
  if (sources.length) {
    sections.push('', '## All relevant citations', '', '_Includes citations used in the answer and additional evidence independently verified as relevant._');
    sources.forEach((source, index) => {
      const number = Number(source.citationNumber) || index + 1;
      const details = sourceDetails(source);
      sections.push('', `### [${number}] ${clean(source.title) || 'Corpus source'}`);
      if (details.length) sections.push('', details.map((detail) => `- ${detail}`).join('\n'));
      sections.push('', `**${excerptLabel(source)}**`, '', quoteMarkdown(source.excerpt));
    });
  }
  return `${sections.join('\n')}\n`;
}

export function answerExportText({ title, message }) {
  const heading = clean(title) || 'GPT corpus answer';
  const sections = [heading, '='.repeat(Math.min(heading.length, 80)), '', clean(message?.content)];
  const sources = exportSources(message);
  if (sources.length) {
    sections.push('', 'ALL RELEVANT CITATIONS', '----------------------', 'Includes citations used in the answer and additional evidence independently verified as relevant.');
    sources.forEach((source, index) => {
      const number = Number(source.citationNumber) || index + 1;
      const details = sourceDetails(source);
      sections.push('', `[${number}] ${clean(source.title) || 'Corpus source'}`, ...details, `${excerptLabel(source)}:`, clean(source.excerpt));
    });
  }
  return `${sections.join('\n')}\n`;
}

export function answerExportHtml({ title, message, wordCompatible = false }) {
  const heading = clean(title) || 'GPT corpus answer';
  const sources = exportSources(message);
  const sourceSection = sources.length ? `<section class="citations"><h2>All relevant citations</h2><p class="citation-note">Includes citations used in the answer and additional evidence independently verified as relevant.</p>${sources.map(citationHtml).join('\n')}</section>` : '';
  return `<!doctype html>
<html lang="en"${wordCompatible ? ' xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"' : ''}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title>${wordCompatible ? '<meta name="ProgId" content="Word.Document">' : ''}<style>${documentCss()}</style></head>
<body><main><header><div class="kicker">Local Corpus GPT</div><h1>${escapeHtml(heading)}</h1></header><section class="answer"><h2>Answer</h2>${markdownBlocksHtml(message?.content)}</section>${sourceSection}</main></body>
</html>`;
}

export function conversationExportHtml({ title, messages }) {
  const heading = clean(title) || 'GPT corpus conversation';
  const turns = conversationTurns(messages);
  const turnSections = turns.map((turn, turnIndex) => {
    const answers = turn.answers.map((message, answerIndex) => {
      const sources = exportSources(message);
      const citations = sources.length ? `<section class="answer-citations"><h3>All relevant citations</h3><p class="citation-note">Includes citations used in the answer and additional evidence independently verified as relevant.</p>${sources.map(citationHtml).join('\n')}</section>` : '';
      const version = turn.answers.length > 1 ? `<div class="answer-version">Answer ${answerIndex + 1} of ${turn.answers.length}</div>` : '';
      return `<section class="answer-block"><h2>Answer</h2>${version}${markdownBlocksHtml(message.content)}${citations}</section>`;
    }).join('\n');
    return `<section class="chat-turn"><div class="turn-number">Conversation turn ${turnIndex + 1}</div><section class="question"><h2>Question</h2><p>${escapeHtml(turn.question || 'Question unavailable').replace(/\n/gu, '<br>')}</p></section>${answers || '<p class="citation-note">No answer was recorded for this question.</p>'}</section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title><style>${documentCss()}</style></head>
<body><main><header><div class="kicker">Local Corpus GPT - Complete Chat</div><h1>${escapeHtml(heading)}</h1></header>${turnSections || '<p>No messages have been recorded in this chat.</p>'}</main></body>
</html>`;
}

export function answerExportFilename(title, extension = 'md') {
  const base = clean(title).normalize('NFKC').replace(/[\\/:*?"<>|]+/gu, '-').replace(/\s+/gu, ' ').slice(0, 80).trim().replace(/[-\s]+$/gu, '');
  return `${base || 'gpt-corpus-answer'}.${extension}`;
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function printAnswerPdf({ title, message }) {
  printHtmlPdf({ title, html: answerExportHtml({ title, message }) });
}

function printHtmlPdf({ title, html }) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.width = '1px'; frame.style.height = '1px'; frame.style.right = '0'; frame.style.bottom = '0'; frame.style.opacity = '0'; frame.style.border = '0';
  document.body.appendChild(frame);
  const frameDocument = frame.contentDocument;
  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
  const printWindow = frame.contentWindow;
  const remove = () => { if (frame.isConnected) frame.remove(); };
  printWindow.addEventListener('afterprint', remove, { once: true });
  window.setTimeout(() => {
    printWindow.document.title = answerExportFilename(title, 'pdf').replace(/\.pdf$/u, '');
    printWindow.focus();
    printWindow.print();
  }, 100);
  window.setTimeout(remove, 60000);
}

export function printConversationPdf({ title, messages }) {
  printHtmlPdf({ title, html: conversationExportHtml({ title, messages }) });
}

export function exportConversationPdf({ title, messages }) {
  const heading = clean(title) || 'GPT corpus conversation';
  printHtmlPdf({ title: `${heading} - complete chat`, html: conversationExportHtml({ title: heading, messages }) });
}

export function exportAnswer({ format, title, message }) {
  if (format === 'pdf') { printAnswerPdf({ title, message }); return; }
  if (format === 'txt') {
    downloadBlob(answerExportText({ title, message }), 'text/plain;charset=utf-8', answerExportFilename(title, 'txt')); return;
  }
  if (format === 'doc') {
    downloadBlob(answerExportHtml({ title, message, wordCompatible: true }), 'application/msword;charset=utf-8', answerExportFilename(title, 'doc')); return;
  }
  if (format === 'html') {
    downloadBlob(answerExportHtml({ title, message }), 'text/html;charset=utf-8', answerExportFilename(title, 'html')); return;
  }
  downloadBlob(answerExportMarkdown({ title, message }), 'text/markdown;charset=utf-8', answerExportFilename(title, 'md'));
}

export function downloadAnswerMarkdown({ title, message }) {
  exportAnswer({ format: 'md', title, message });
}
