function sourceOrderValue(record) {
  const metadataOrder = Number(record?.metadata?.chunk_index);
  if (Number.isFinite(metadataOrder)) return metadataOrder;
  const directOrder = Number(record?.sourceOrder);
  return Number.isFinite(directOrder) ? directOrder : Number.MAX_SAFE_INTEGER;
}

function longestSuffixPrefixOverlap(left, right, maximum = 1200) {
  const a = String(left || '');
  const b = String(right || '');
  const limit = Math.min(a.length, b.length, Math.max(0, Number(maximum) || 0));
  for (let length = limit; length >= 24; length -= 1) {
    if (a.slice(-length) === b.slice(0, length)) return length;
  }
  return 0;
}

function reconstructDocument(records) {
  const ordered = [...(Array.isArray(records) ? records : [])]
    .sort((left, right) => sourceOrderValue(left) - sourceOrderValue(right) || String(left.sourceId).localeCompare(String(right.sourceId)));
  if (!ordered.length) return null;
  let text = '';
  const chunks = [];
  for (const record of ordered) {
    const answer = String(record.answer || '');
    const overlap = text ? longestSuffixPrefixOverlap(text, answer) : 0;
    const separator = text && !overlap ? '\n\n' : '';
    const baseOffset = text.length + separator.length - overlap;
    text += separator + answer.slice(overlap);
    chunks.push({
      sourceId: String(record.sourceId),
      sourceOrder: record.sourceOrder ?? null,
      start: baseOffset,
      end: baseOffset + answer.length,
      overlap,
      answerLength: answer.length,
    });
  }
  const first = ordered[0];
  return {
    sourceGroup: first.sourceGroup || first.sourceId,
    sourceType: first.metadata?.source_type || null,
    title: first.question,
    metadata: first.metadata || {},
    text,
    chunks,
  };
}

function mapDocumentHighlights(document, highlights) {
  if (!document) return [];
  const chunks = new Map(document.chunks.map((chunk) => [String(chunk.sourceId), chunk]));
  return (Array.isArray(highlights) ? highlights : []).flatMap((highlight, index) => {
    const chunk = chunks.get(String(highlight.sourceId));
    const start = Number(highlight.start);
    const end = Number(highlight.end);
    if (!chunk || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > chunk.answerLength) return [];
    return [{
      start: chunk.start + start,
      end: chunk.start + end,
      sourceId: String(highlight.sourceId),
      label: String(highlight.label || `Evidence ${index + 1}`),
      evidenceNumber: Number.isInteger(Number(highlight.evidenceNumber)) ? Number(highlight.evidenceNumber) : null,
    }];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
}

module.exports = {
  longestSuffixPrefixOverlap,
  mapDocumentHighlights,
  reconstructDocument,
  sourceOrderValue,
};
