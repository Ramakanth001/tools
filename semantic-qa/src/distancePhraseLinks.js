// Repeated, distinctive answer phrases can supply another author's wording of
// the same question. Links add retrieval evidence and carry no citation data.
function phraseKeys(document, frequencies, corpusSize) {
  const positions = new Map();
  for (const [term, hits] of document.answer) {
    for (const position of hits) if (!positions.has(position)) positions.set(position, term);
  }
  const words = [...positions].sort((a, b) => a[0] - b[0]);
  const keys = new Set();
  for (let i = 0; i + 4 < words.length; i++) {
    if (words[i + 4][0] - words[i][0] > 11) continue;
    const sequence = words.slice(i, i + 5).map(words => words[1]);
    if (new Set(sequence).size < 4) continue;
    if (!sequence.some(term => (frequencies.get(term) || 0) < Math.max(3, corpusSize * 0.04))) continue;
    keys.add(sequence.join(' '));
  }
  return keys;
}

function buildPhraseLinks(documents, frequencies) {
  const units = [...documents.values()];
  const signatures = units.map(document => phraseKeys(document, frequencies, units.length));
  const inverted = new Map();
  for (const [id, keys] of signatures.entries()) {
    for (const key of keys) {
      const hits = inverted.get(key);
      if (hits === undefined) inverted.set(key, id);
      else if (typeof hits === 'number') inverted.set(key, [hits, id]);
      else if (hits.length <= 16) hits.push(id);
    }
  }

  return new Map(units.map((document, id) => {
    const matches = new Map();
    for (const key of signatures[id]) {
      const hits = inverted.get(key);
      if (!Array.isArray(hits) || hits.length > 16) continue;
      for (const other of hits) {
        if (units[other].sourceId === document.sourceId || !units[other].questionText?.includes('?')) continue;
        matches.set(other, (matches.get(other) || 0) + 1);
      }
    }
    const neighbors = [...matches].flatMap(([other, shared]) => {
      const shorter = Math.min(signatures[id].size, signatures[other].size);
      const ratio = shared / Math.max(1, shorter);
      if (shared < 3 || (shared < 12 && ratio < 0.40)) return [];
      return [{ other, strength: Math.min(1, (shared / 20) + ratio * 0.7) }];
    }).sort((a, b) => b.strength - a.strength || a.other - b.other).slice(0, 5);
    return [document, neighbors.map(item => ({ document: units[item.other], strength: item.strength }))];
  }).filter(([, links]) => links.length > 0));
}

module.exports = { buildPhraseLinks };
