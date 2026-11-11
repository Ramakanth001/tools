const test = require('node:test');
const assert = require('node:assert/strict');
const distanceSearch = require('../src/distanceSearch');
const spiritualEquivalents = require('../src/spiritualEquivalents');

test('foldDiacritics strips IAST macrons, underdots, and accents accurately', () => {
  assert.equal(distanceSearch.foldDiacritics('gāyatrī'), 'gayatri');
  assert.equal(distanceSearch.foldDiacritics('Sāvitrī'), 'Savitri');
  assert.equal(distanceSearch.foldDiacritics('Śaṅkara'), 'Sankara');
  assert.equal(distanceSearch.foldDiacritics('Ādiparāśakti'), 'Adiparasakti');
  assert.equal(distanceSearch.foldDiacritics('Kṛṣṇa'), 'Krsna');
  assert.equal(distanceSearch.foldDiacritics('Ṛgveda'), 'Rgveda');
  assert.equal(distanceSearch.foldDiacritics('plain english text'), 'plain english text');
  assert.equal(distanceSearch.foldDiacritics(''), '');
  assert.equal(distanceSearch.foldDiacritics(null), '');
});

test('canonicalizeSpiritualTerm resolves spelling & transliteration variants to canonical roots', () => {
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('gayatri'), 'gayatri');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('gayathri'), 'gayatri');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('gāyatrī'), 'gayatri');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('gayathry'), 'gayatri');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('savitri'), 'savitri');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('savithri'), 'savitri');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('sāvitrī'), 'savitri');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('shankara'), 'shankara');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('sankara'), 'shankara');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('śaṅkara'), 'shankara');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('adiparashakti'), 'adiparashakti');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('ādiparāśakti'), 'adiparashakti');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('adiparasakthi'), 'adiparashakti');

  // Generic words must remain untouched
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('what'), 'what');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('is'), 'is');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('the'), 'the');
});

test('LRUCache evicts the least recently used entry and updates recency on get', () => {
  const lru = new distanceSearch.LRUCache(3);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  assert.equal(lru.size, 3);

  // Access 'a' to make it recently used
  assert.equal(lru.get('a'), 1);

  // Insert 'd', which should evict 'b' (oldest unaccessed)
  lru.set('d', 4);
  assert.equal(lru.size, 3);
  assert.equal(lru.get('b'), undefined);
  assert.equal(lru.get('a'), 1);
  assert.equal(lru.get('c'), 3);
  assert.equal(lru.get('d'), 4);
});

test('splitIntoCleanSentences protects abbreviations and does not cut sentences mid-word', () => {
  const text = '[Smt. Chhanda asked:- Paadanamaskaaram Swami, please clarify the following doubts: In last Saturday’s Satsang, You explained very beautifully the real meaning of Gayatri mantra w.r.t. the movie songs. Every detail You brought out from real meaning to protection from God. I will request You once to kindly explain it once again.]';

  const sentences = distanceSearch.splitIntoCleanSentences(text);
  assert.ok(sentences.length >= 2, 'Should detect multiple sentences');

  // Verify that w.r.t. was not split
  const firstSentence = sentences[0].text;
  assert.ok(firstSentence.includes('w.r.t. the movie songs'), 'Sentence should contain intact w.r.t. abbreviation');
  assert.ok(firstSentence.startsWith('[Smt. Chhanda asked'), 'Sentence should start cleanly with Smt. intact');

  // Verify that offsets accurately slice the original text
  for (const s of sentences) {
    const sliced = text.slice(s.start, s.end);
    assert.equal(sliced, s.text, 'Offset slice must match s.text character-for-character');
  }
});

test('extractMultiSentenceSnippet calculates offsets strictly relative to the answer text', () => {
  const answer = 'Therefore, any song related to God that attracts your mind to the highest order and makes you repeat it again and again is called as Gayatri Mantra. People may misunderstand that you are a devotee of God by hearing such divine song from your mouth. The public opinion is not the standard.';

  const contentWords = ['gayatri', 'mantra', 'meaning'];
  const weightedPhrases = [
    { text: 'gayatri mantra', weight: 500, regex: /(?<=^|\s)gayatri mantra(?=\s|$)/gi }
  ];

  const result = distanceSearch.extractMultiSentenceSnippet(answer, contentWords, weightedPhrases, answer);
  assert.ok(result.snippetText.length > 0, 'Snippet must not be empty');
  assert.ok(result.targetPassage.length > 0, 'Target passage must not be empty');
  assert.ok(result.passageOffset.end > result.passageOffset.start, 'End offset must exceed start offset');

  // Crucial test: slicing answer directly using passageOffset must equal passageOffset.text
  const sliced = answer.slice(result.passageOffset.start, result.passageOffset.end);
  assert.equal(sliced, result.passageOffset.text, 'Slicing answer by passageOffset must reproduce target passage exactly');
  assert.ok(result.passageOffset.end <= answer.length, 'End offset must never exceed answer length');
});

test('scoreDiscourse enforces title authority tiers and does not return rawDoc', () => {
  const query = 'what is the real meaning of Gayatri mantra?';
  const queryWords = ['what', 'is', 'the', 'real', 'meaning', 'of', 'gayatri', 'mantra'];
  const contentWords = ['real', 'meaning', 'gayatri', 'mantra'];
  const subjects = ['gayatri', 'mantra'];
  const intents = ['meaning', 'real'];
  const weightedPhrases = [
    { text: 'gayatri mantra', weight: 1000, hasRareEntity: true, tokens: ['gayatri', 'mantra'], regex: /(?<=^|\s)gayatri mantra(?=\s|$)/gi },
    { text: 'meaning of gayatri mantra', weight: 4000, hasRareEntity: true, tokens: ['meaning', 'of', 'gayatri', 'mantra'], regex: /(?<=^|\s)meaning of gayatri mantra(?=\s|$)/gi }
  ];
  const idfMap = { gayatri: 4.1, mantra: 2.7, meaning: 1.5, real: 1.2 };

  // Doc A: Title matches topic phrase
  const docA = {
    source_id: 'doc:1',
    question: 'Clarifications on Gayathri Mantra',
    answer: 'Swami replied:- When the root meaning of the Gayathri mantra is described as a song on God, Gayatri means a divine song.',
    metadata: { question_context: 'Devotee asked a long background question that should not contaminate offsets.' }
  };

  // Doc B: Body-only match (Guru Dakshina mentioning gayatri mantra in body)
  const docB = {
    source_id: 'doc:2',
    question: 'Importance of Guru Dakshina in Spiritual Path',
    answer: 'Swami replied:- In Guru Dakshina you surrender your wealth. Even in chanting Gayatri mantra, sacrifice of fruit of work is the highest worship.',
    metadata: {}
  };

  const scoredA = distanceSearch.scoreDiscourse(docA, query, queryWords, contentWords, weightedPhrases, idfMap, subjects, intents);
  const scoredB = distanceSearch.scoreDiscourse(docB, query, queryWords, contentWords, weightedPhrases, idfMap, subjects, intents);

  assert.ok(scoredA, 'Doc A should be scored');
  assert.ok(scoredB, 'Doc B should be scored');

  // Title match MUST strictly outrank body-only match
  assert.ok(scoredA.totalScore > scoredB.totalScore, 'Doc with title topic match must strictly outrank body-only match');
  assert.ok(scoredA.titleScore >= 280000, 'Doc A should receive Tier 1 title score');
  assert.equal(scoredB.titleScore, 0, 'Doc B should receive 0 title score');

  // Verify rawDoc is NOT present on the returned object (preventing JSON payload bloat)
  assert.equal(scoredA.rawDoc, undefined, 'rawDoc must be deleted to keep JSON payload lightweight');
  assert.equal(scoredB.rawDoc, undefined, 'rawDoc must be deleted to keep JSON payload lightweight');
});

test('spiritualEquivalents includes IAST accented variants in getSpiritualVariants', () => {
  const variants = spiritualEquivalents.getSpiritualVariants('gayatri');
  assert.ok(Array.isArray(variants), 'Variants must be an array');
  assert.ok(variants.includes('gayatri'), 'Must include clean ASCII gayatri');
  assert.ok(variants.includes('gayathri'), 'Must include gayathri');
  assert.ok(variants.includes('gāyatrī'), 'Must include IAST accented gāyatrī for PostgreSQL GIN matching');

  const savitriVariants = spiritualEquivalents.getSpiritualVariants('savitri');
  assert.ok(savitriVariants.includes('sāvitrī'), 'Must include IAST accented sāvitrī');
  assert.ok(!savitriVariants.includes('savita'), 'Savitri must NOT collapse into Savita');

  const savitaVariants = spiritualEquivalents.getSpiritualVariants('savita');
  assert.ok(savitaVariants.includes('savita'), 'Savita must include savita');
  assert.ok(!savitaVariants.includes('savitri'), 'Savita must NOT collapse into Savitri');

  assert.equal(distanceSearch.canonicalizeSpiritualTerm('sandhya'), 'sandhya', 'Sandhya must not collapse to sandhyavandanam');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('vandanam'), 'vandanam', 'Vandanam must not collapse to sandhyavandanam');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('sandhyavandanam'), 'sandhyavandanam', 'Sandhyavandanam canonicalizes to sandhyavandanam');

  // Multi-word composite phrase handling preserves independent terms while linking ritual compound
  assert.equal(distanceSearch.normalizeSpiritual('Sandhyaa Vandanam'), 'sandhyavandanam', 'Sandhyaa Vandanam normalizes to sandhyavandanam');
  assert.equal(distanceSearch.normalizeSpiritual('Sandhya prayer'), 'sandhya prayer', 'Standalone Sandhya remains independent');
  assert.equal(distanceSearch.normalizeSpiritual('Offering Vandanam'), 'offering vandanam', 'Standalone Vandanam remains independent');
});

test('preserves distinct spiritual concepts without conflating related ideas', () => {
  assert.equal(distanceSearch.normalizeSpiritual('remedy for anger'), 'remedy for anger', 'Remedy must not collapse to astrology');
  assert.equal(distanceSearch.normalizeSpiritual('Yajna Vichaara Yoga'), 'yajna vichaara yoga', 'Vichaara must not collapse to caste');
  assert.equal(distanceSearch.normalizeSpiritual('Kshatriya Vaishya Shudra'), 'kshatriya vaishya shudra', 'Individual varnas must not collapse to caste');
  assert.equal(distanceSearch.normalizeSpiritual('Shravanam Kirtanam'), 'shravana kirtana', 'Shravana and kirtana must not collapse to navavidha');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('remedy'), 'remedy');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('vichaara'), 'vichaara');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('kshatriya'), 'kshatriya');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('shravanam'), 'shravana');
});
