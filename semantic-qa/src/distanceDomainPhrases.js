const { cleanToken } = require('./spiritualEquivalents');

// Keep doctrinal senses separate. A group supplies alternate surface wording
// for one concept and adds an extra feature alongside literal word matching.
const groups = [
  ['worldly duty', 'worldly duties', 'family duty', 'family duties', 'worldly work', 'social duty', 'pravritti', 'pravrutti'],
  ['spiritual path', 'nivrutti', 'nivritti', 'spiritual line'],
  ['spiritual practice', 'spiritual effort', 'sadhana'],
  ['spiritual knowledge', 'divine knowledge', 'jnana', 'jnanam', 'gnana', 'gnanam'],
  ['devotion', 'bhakti', 'bhakthi'],
  ['detachment', 'dispassion', 'vairagya', 'vairagyam', 'non attachment'],
  ['true spiritual teacher', 'divine preacher', 'sadguru', 'satguru', 'preceptor'],
  ['human incarnation', 'human form of god', 'human avatar', 'manusha avatara'],
  ['energetic incarnation', 'energetic form of god', 'energetic avatar'],
  ['monistic incarnation', 'advaita avatara'],
  ['dualistic incarnation', 'dvaita avatara'],
  ['unimaginable god', 'unmediated god', 'parabrahman', 'parabrahmam', 'parabrahma'],
  ['mediated god', 'god in a medium'],
  ['individual soul', 'jeeva', 'jiva', 'jivatma'],
  ['basic soul', 'atman', 'atma', 'athma'],
  ['causal body', 'karana sharira', 'kaarana shariira', 'kaarana shareera', 'karana sarira'],
  ['great causal body', 'mahakarana sharira', 'mahaakaarana shariira', 'maha karana sharira'],
  ['three qualities', 'three gunas', 'three gunas of nature', 'triguna', 'trigunas'],
  ['balance of qualities', 'residual qualities', 'guna shesha', 'gunashesha', 'gunasesha'],
  ['karma shesha', 'karma sesha', 'karmashesha', 'remnant of actions', 'remainder of deeds'],
  ['fruit of action', 'fruit of work', 'fruits of actions', 'karma phala', 'karmaphala'],
  ['sacrifice of work', 'sacrifice of service', 'karma samnyasa', 'karma sanyasa'],
  ['sacrifice of the fruit of work', 'sacrifice of the fruit of action', 'karma phala tyaga', 'karmaphala tyaga'],
  ['fascination for beauty', 'fascination with beauty', 'rupabhranti', 'roopa bhranti'],
  ['salvation', 'liberation', 'moksha', 'mukti', 'mukthi'],
  ['sacred thread', 'upanayanam', 'upanayana'],
  ['holy company', 'spiritual company', 'satsanga', 'satsang'],
  ['holy spirit', 'holy ghost'],
];

// First match the longest phrase at a position. "Great causal body" is an
// independent concept and cannot also count as an occurrence of causal body.
const byStart = new Map();
for (const [id, variants] of groups.entries()) {
  for (const variant of variants) {
    const phrase = cleanToken(variant).split(' ');
    let choices = byStart.get(phrase[0]);
    if (!choices) byStart.set(phrase[0], choices = []);
    choices.push({ id, phrase });
  }
}
for (const choices of byStart.values()) choices.sort((a, b) => b.phrase.length - a.phrase.length);

function domainConcepts(text) {
  const words = cleanToken(text).split(' ');
  const found = new Map();
  for (let position = 0; position < words.length; position++) {
    const relevant = byStart.get(words[position]);
    const match = relevant?.find(({ phrase }) => phrase.every((term, index) => term === words[position + index]));
    if (!match) continue;
    let locations = found.get(match.id);
    if (!locations) found.set(match.id, locations = []);
    locations.push(position + 1);
    position += match.phrase.length - 1;
  }
  return found;
}

function domainEvidence(concepts, positions) {
  if (!concepts.size || !positions) return [0, 0];
  let matches = 0;
  let near = 0;
  const hits = [];
  for (const id of concepts.keys()) {
    const locations = positions.get(id);
    if (!locations) continue;
    matches++;
    for (const position of locations) hits.push({ position, id });
  }
  hits.sort((a, b) => a.position - b.position);
  let left = 0;
  const visible = new Map();
  for (const hit of hits) {
    visible.set(hit.id, (visible.get(hit.id) || 0) + 1);
    while (hit.position - hits[left].position > 38) {
      const { id } = hits[left++];
      if (visible.get(id) === 1) visible.delete(id);
      else visible.set(id, visible.get(id) - 1);
    }
    near = Math.max(near, visible.size);
  }
  return [matches / concepts.size, near / concepts.size];
}

module.exports = { domainConcepts, domainEvidence };
