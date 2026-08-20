const test = require('node:test');
const assert = require('node:assert/strict');
const {
  longestSuffixPrefixOverlap,
  mapDocumentHighlights,
  reconstructDocument,
} = require('../src/documentService');

test('reconstructs an ordered discourse without repeating importer overlap', () => {
  const overlap = 'This sentence is repeated across the chunk boundary.';
  const document = reconstructDocument([
    { sourceId: 'discourse:810:002', sourceGroup: 'discourse:810', sourceOrder: 2, question: 'Title', answer: `${overlap} Final section.`, metadata: { source_type: 'discourse' } },
    { sourceId: 'discourse:810:001', sourceGroup: 'discourse:810', sourceOrder: 1, question: 'Title', answer: `Opening section. ${overlap}`, metadata: { source_type: 'discourse' } },
  ]);
  assert.equal(longestSuffixPrefixOverlap(document.text.slice(0, 80), overlap), 0);
  assert.equal(document.text, `Opening section. ${overlap} Final section.`);
  assert.equal(document.chunks[1].overlap, overlap.length);
});

test('maps chunk-relative evidence offsets into the reconstructed discourse', () => {
  const document = reconstructDocument([
    { sourceId: 'a', sourceGroup: 'g', sourceOrder: 1, question: 'Q', answer: 'Alpha evidence.', metadata: {} },
    { sourceId: 'b', sourceGroup: 'g', sourceOrder: 2, question: 'Q', answer: 'Beta evidence.', metadata: {} },
  ]);
  const highlights = mapDocumentHighlights(document, [{ sourceId: 'b', start: 5, end: 13, evidenceNumber: 2 }]);
  assert.equal(document.text.slice(highlights[0].start, highlights[0].end), 'evidence');
  assert.equal(highlights[0].evidenceNumber, 2);
  assert.deepEqual(mapDocumentHighlights(document, [{ sourceId: 'b', start: -1, end: 9 }]), []);
});
