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
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('Brahman'), 'brahman');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('Brahmam'), 'brahman');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('Brahmin'), 'brahmin');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('Brahmana'), 'brahmin');
  assert.equal(
    distanceSearch.normalizeSearchQuery('Is removal of ignorance the same as realization of Brahman?').normalizedQuery,
    'is removal of maya the same as realization of brahman'
  );

  // Generic words must remain untouched
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('what'), 'what');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('is'), 'is');
  assert.equal(distanceSearch.canonicalizeSpiritualTerm('the'), 'the');
});

test('legacy-compatible AUTO fuzziness corrects unambiguous domain typos without changing short or ambiguous words', () => {
  assert.equal(distanceSearch.autoFuzzinessMaxEdits('at'), 0);
  assert.equal(distanceSearch.autoFuzzinessMaxEdits('soul'), 1);
  assert.equal(distanceSearch.autoFuzzinessMaxEdits('gayatri'), 2);
  assert.equal(distanceSearch.boundedDamerauLevenshtein('gyaatri', 'gayatri', 2), 1);

  const normalized = distanceSearch.normalizeSearchQuery('What is the meanning of Gyaatri mantra?');
  assert.equal(normalized.normalizedQuery, 'what is the meaning of gayatri mantra');
  assert.deepEqual(normalized.corrections, [
    { from: 'meanning', to: 'meaning' },
    { from: 'gyaatri', to: 'gayatri' },
  ]);

  assert.equal(distanceSearch.correctFuzzyQueryToken('at'), 'at');
  assert.equal(distanceSearch.correctFuzzyQueryToken('son'), 'son');
  assert.equal(distanceSearch.correctFuzzyQueryToken('sita'), 'sita');
  assert.equal(distanceSearch.correctFuzzyQueryToken('mean'), 'mean');
  assert.equal(distanceSearch.correctFuzzyQueryToken('state'), 'state');
  assert.equal(distanceSearch.correctFuzzyQueryToken('dead'), 'dead');
  assert.equal(distanceSearch.correctFuzzyQueryToken('medication'), 'medication');
  assert.equal(distanceSearch.correctFuzzyQueryToken('brahma'), 'brahma');
  assert.equal(distanceSearch.correctFuzzyQueryToken('gopikas'), 'gopika');
  assert.equal(distanceSearch.correctFuzzyQueryToken('unlistedpropername'), 'unlistedpropername');
});

test('corpus-backed spelling corrects only uniquely supported adjacent transpositions', async () => {
  const counts = new Map([
    ['however', 400],
    ['incarnate', 120],
    ['medication', 35],
    ['meditacion', 0],
  ]);
  const pool = {
    async query() {
      return { rows: [...counts].map(([word, count]) => ({ word, count })) };
    },
  };
  const result = await distanceSearch.correctCorpusTranspositions(
    pool,
    'howveer god incanrate medication'
  );
  assert.equal(result.normalizedQuery, 'however god incarnate medication');
  assert.deepEqual(result.corrections, [
    { from: 'howveer', to: 'however' },
    { from: 'incanrate', to: 'incarnate' },
  ]);
});

test('corpus-backed spelling repairs missing and repeated characters while preserving corpus words', async () => {
  const counts = new Map([
    ['servant', 140], ['serant', 0],
    ['devotee', 220], ['devootee', 0],
    ['important', 500], ['impotant', 0],
    ['weakness', 90], ['weakens', 8], ['weaknes', 0],
    ['medication', 35],
  ]);
  const pool = {
    async query() {
      return { rows: [...counts].map(([word, count]) => ({ word, count })) };
    },
  };
  const result = await distanceSearch.correctCorpusSpelling(
    pool,
    'serant devootee impotant weaknes medication'
  );
  assert.equal(result.normalizedQuery, 'servant devotee important weakness medication');
  assert.deepEqual(result.corrections, [
    { from: 'serant', to: 'servant' },
    { from: 'devootee', to: 'devotee' },
    { from: 'impotant', to: 'important' },
    { from: 'weaknes', to: 'weakness' },
  ]);
});

test('spell correction uses the selected database vocabulary and retries failed lookups', async () => {
  const correctionPool = { async query() { return { rows: [{ word: 'however', count: 150 }] }; } };
  let fail = true;
  const preservingPool = { async query() {
    if (fail) throw new Error('Database temporarily unavailable');
    return { rows: [{ word: 'howveer', count: 2 }, { word: 'however', count: 150 }] };
  } };
  const input = 'howveer God'.toLowerCase();
  assert.equal((await distanceSearch.correctCorpusSpelling(correctionPool, input)).normalizedQuery, 'however god');
  assert.equal((await distanceSearch.correctCorpusSpelling(preservingPool, input)).normalizedQuery, 'howveer god');
  fail = false;
  assert.equal((await distanceSearch.correctCorpusSpelling(preservingPool, input)).normalizedQuery, 'howveer god');
  assert.equal((await distanceSearch.correctCorpusSpelling(correctionPool, input)).normalizedQuery, 'however god');
});

test('a timed-out full-text passage scan releases the transaction and retries exact passages', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (params?.[3]) throw Object.assign(new Error('Statement timed out'), { code: '57014' });
    },
    release(error) { calls.push(['release', error]); },
  };
  const pool = {
    async connect() { return client; },
    async query(sql, params) { calls.push([sql, params]); return { rows: [{ id: 'exact' }] }; },
  };
  const params = ['terms', 'phrase', '%phrase%', true];
  const timings = {};
  assert.deepEqual(await distanceSearch.queryDistancePassages(pool, 'select passages', params, timings), { rows: [{ id: 'exact' }] });
  assert.equal(timings.fullTextPassageTimedOut, true);
  assert.deepEqual(calls, [
    ['BEGIN READ ONLY', undefined],
    ["SET LOCAL statement_timeout = '4000ms'", undefined],
    ['select passages', params],
    ['ROLLBACK', undefined],
    ['release', undefined],
    ['select passages', ['terms', 'phrase', '%phrase%', false]],
  ]);
});

test('corpus-backed spelling refuses ambiguous edits without a threefold frequency margin', async () => {
  const counts = new Map([
    ['alter', 12],
    ['after', 8],
    ['ater', 0],
  ]);
  const pool = {
    async query() {
      return { rows: [...counts].map(([word, count]) => ({ word, count })) };
    },
  };
  const result = await distanceSearch.correctCorpusSpelling(pool, 'ater');
  assert.equal(result.normalizedQuery, 'ater');
  assert.deepEqual(result.corrections, []);
});

test('corpus-backed correction never rewrites unsupported technical vocabulary without spiritual context', async () => {
  distanceSearch.clearIdfCache();
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rows: [{ word: 'oath', count: 100 }, { word: 'done', count: 100 }] };
    },
  };
  const result = await distanceSearch.correctCorpusSpelling(
    pool,
    'configure oauth token rotation for autonomous drone firmware'
  );
  assert.equal(result.normalizedQuery, 'configure oauth token rotation for autonomous drone firmware');
  assert.deepEqual(result.corrections, []);
  const morphology = await distanceSearch.correctControlledMorphology(
    pool,
    'how should blockchain smart contracts be configured'
  );
  assert.equal(morphology.normalizedQuery, 'how should blockchain smart contracts be configured');
  assert.deepEqual(morphology.corrections, []);
  assert.equal(queried, false);
  assert.equal(distanceSearch.hasSpiritualSearchContext(['spirtiual', 'question']), true);
});

test('controlled morphology repairs only unattested malformed forms in decisive grammar contexts', async () => {
  distanceSearch.clearIdfCache();
  const counts = new Map([
    ['energy', 90], ['energys', 0],
    ['attached', 70], ['attacheds', 0],
    ['choosing', 55], ['choosings', 0],
    ['devotee', 120], ['devotees', 25],
    ['reference', 80], ['references', 40],
  ]);
  const pool = {
    async query() {
      return { rows: [...counts].map(([word, count]) => ({ word, count })) };
    },
  };
  const malformed = await distanceSearch.correctControlledMorphology(
    pool,
    'sacrifice of energys one is attacheds more before choosings a partner'
  );
  assert.equal(
    malformed.normalizedQuery,
    'sacrifice of energy one is attached more before choosing a partner'
  );
  assert.deepEqual(malformed.corrections, [
    { from: 'energys', to: 'energy' },
    { from: 'attacheds', to: 'attached' },
    { from: 'choosings', to: 'choosing' },
  ]);

  const valid = await distanceSearch.correctControlledMorphology(
    pool,
    'a devotees question with references to teachings'
  );
  assert.equal(valid.normalizedQuery, 'a devotees question with references to teachings');
  assert.deepEqual(valid.corrections, []);
});

test('contextual correction distinguishes spiritual angels from geometric angles', () => {
  assert.deepEqual(
    distanceSearch.correctContextualQueryTerms('why is dream state absent for angles due to sleep'),
    {
      normalizedQuery: 'why is dream state absent for angels due to sleep',
      corrections: [{ from: 'angles', to: 'angels' }],
    }
  );
  assert.equal(
    distanceSearch.correctContextualQueryTerms('what are the angles of a triangle').normalizedQuery,
    'what are the angles of a triangle'
  );
});

test('natural framing is removed for retrieval without changing the core question', () => {
  assert.equal(
    distanceSearch.stripSearchFraming('Regarding this specific issue, will God reward the affected souls?'),
    'will God reward the affected souls?'
  );
  assert.equal(
    distanceSearch.stripSearchFraming('From a practical standpoint, how can laziness be overcome?'),
    'how can laziness be overcome?'
  );
  assert.equal(
    distanceSearch.stripSearchFraming('Why is every soul not God?'),
    'Why is every soul not God?'
  );
});

test('PostgreSQL-native search eligibility excludes ambiguous records without citable answer units', () => {
  assert.equal(distanceSearch.isSearchEligibleMetadata({ ambiguous: true, answer_unit_count: 0 }), false);
  assert.equal(distanceSearch.isSearchEligibleMetadata({ ambiguous: 'true', answer_unit_count: '0' }), false);
  assert.equal(distanceSearch.isSearchEligibleMetadata({ ambiguous: false, answer_unit_count: 0 }), false);
  assert.equal(distanceSearch.isSearchEligibleMetadata({ ambiguous: false, answer_unit_count: 2 }), true);
  assert.equal(distanceSearch.isSearchEligibleMetadata({ source_type: 'qa' }), true);
  assert.match(distanceSearch.searchEligibilitySql('r'), /answer_unit_count/);
});

test('passage-native channel fusion preserves distinct answer units and removes only the record fallback', () => {
  const candidates = distanceSearch.fuseDistanceCandidateChannels({
    recordRows: [
      { source_id: 'doc:1', question: 'Shared document', answer: 'Whole record' },
      { source_id: 'doc:2', question: 'Record-only fallback', answer: 'Fallback answer' },
      { source_id: 'doc:3', question: 'Structured record', answer: 'Must not be scored whole', metadata: { answer_unit_count: 2 } },
    ],
    discoveryRows: [
      { source_id: 'doc:1', matched_answer_unit_id: 'doc:1:reply:1', matched_discovery_text: 'First question', discovery_exact_match: true },
    ],
    answerUnitRows: [
      { source_id: 'doc:1', matched_answer_unit_id: 'doc:1:reply:2', matched_answer_unit_text: 'Second answer' },
    ],
    passageRows: [
      { source_id: 'doc:1', matched_answer_unit_id: 'doc:1:reply:1', matched_passage_text: 'First passage' },
      { source_id: 'doc:1', matched_answer_unit_id: 'doc:1:reply:2', matched_passage_text: 'Second passage' },
    ],
  });

  assert.equal(candidates.length, 3);
  assert.equal(candidates.some((entry) => distanceSearch.distanceCandidateKey(entry) === 'doc:1\u0000record'), false);
  const first = candidates.find((entry) => entry.matched_answer_unit_id === 'doc:1:reply:1');
  const second = candidates.find((entry) => entry.matched_answer_unit_id === 'doc:1:reply:2');
  const fallback = candidates.find((entry) => entry.source_id === 'doc:2');
  assert.equal(first.record_retrieval_rank, 1);
  assert.equal(first.discovery_retrieval_rank, 1);
  assert.equal(first.passage_retrieval_rank, 1);
  assert.equal(first.discovery_exact_match, true);
  assert.equal(second.answer_unit_retrieval_rank, 1);
  assert.equal(second.passage_retrieval_rank, 2);
  assert.equal(fallback.record_retrieval_rank, 2);
  assert.equal(candidates.some((entry) => entry.source_id === 'doc:3'), false);
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

test('minimal covering span chooses the tightest window containing every principal concept', () => {
  const groups = [new Set(['god']), new Set(['karma']), new Set(['suffering'])];
  const tokens = 'god is discussed with many unrelated words before karma and suffering but god karma suffering explains the point'.split(' ');
  const span = distanceSearch.computeMinimalCoveringSpan(tokens, groups);
  assert.deepEqual(span, {
    start: 12,
    end: 15,
    spanLength: 3,
    requiredConcepts: 3,
    density: 1,
  });
});

test('intent classification and alignment distinguish causal, comparison, definition, and procedure questions', () => {
  assert.equal(distanceSearch.classifySearchIntent('Why does suffering occur?'), 'causal');
  assert.equal(distanceSearch.classifySearchIntent('How do love and lust differ?'), 'comparison');
  assert.equal(distanceSearch.classifySearchIntent('What is liberation?'), 'definition');
  assert.equal(distanceSearch.classifySearchIntent('How can I overcome ego?'), 'procedure');
  assert.equal(distanceSearch.classifySearchIntent('How should the identity of the real sinner be understood?'), 'identity');
  const aligned = distanceSearch.scoreIntentAlignment(
    'causal',
    'Why does God permit suffering?',
    'Suffering occurs because the soul must face the fruit of karma.',
    0.8,
  );
  const unaligned = distanceSearch.scoreIntentAlignment('causal', 'What is suffering?', 'God discusses suffering.', 0.8);
  assert.ok(aligned.score > unaligned.score);
  assert.equal(aligned.discoveryAligned, true);
  assert.equal(aligned.answerAligned, true);
});

test('minimal-covering sentence evidence returns one contiguous exact source slice', () => {
  const answer = 'God is impartial. Many unrelated details are discussed here. Suffering follows karma because deeds produce fruits. Devotion is also important.';
  const sentences = distanceSearch.splitIntoCleanSentences(answer);
  const range = distanceSearch.selectMinimalCoveringSentenceRange(answer, sentences, ['suffering', 'karma', 'deeds']);
  assert.ok(range);
  assert.equal(range.text, 'Suffering follows karma because deeds produce fruits.');
  assert.equal(answer.slice(range.start, range.end), range.text);
});

test('scoreDiscourse rewards an intent-aligned paired question and causal answer', () => {
  const query = 'Why does God permit suffering?';
  const queryWords = ['why', 'does', 'god', 'permit', 'suffering'];
  const contentWords = ['god', 'permit', 'suffering'];
  const weightedPhrases = [];
  const idfMap = { god: 1.2, permit: 2, suffering: 2.5 };
  const subjects = ['god', 'suffering'];
  const intents = ['why'];
  const base = {
    question: 'God and suffering',
    metadata: {},
    matched_answer_unit_start: 0,
  };
  const aligned = distanceSearch.scoreDiscourse({
    ...base,
    source_id: 'aligned',
    answer: 'God permits suffering because karma produces the fruit of deeds.',
    matched_answer_unit_text: 'God permits suffering because karma produces the fruit of deeds.',
    matched_answer_unit_id: 'aligned:1',
    matched_discovery_text: 'Why does God permit suffering?',
  }, query, queryWords, contentWords, weightedPhrases, idfMap, subjects, intents);
  const topical = distanceSearch.scoreDiscourse({
    ...base,
    source_id: 'topical',
    answer: 'God and suffering are spiritual topics. God permits suffering.',
    matched_answer_unit_text: 'God and suffering are spiritual topics. God permits suffering.',
    matched_answer_unit_id: 'topical:1',
    matched_discovery_text: 'What is suffering?',
  }, query, queryWords, contentWords, weightedPhrases, idfMap, subjects, intents);
  assert.ok(aligned.totalScore > topical.totalScore);
  assert.ok(aligned.intentScore > topical.intentScore);
  assert.ok(aligned.minimalSpanScore > 0);
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
  const scoredEmbeddedQuestion = distanceSearch.scoreDiscourse({
    source_id: 'doc:3',
    question: 'Swami answers devotees questions',
    answer: 'Swami replied:- Gayatri mantra is a divine song that protects the singer.',
    metadata: {},
    matched_discovery_text: 'What is the real meaning of Gayatri mantra?',
    matched_answer_unit_text: 'Gayatri mantra is a divine song that protects the singer.',
    matched_answer_unit_id: 'doc:3:reply:1',
    matched_answer_unit_start: 15,
    discovery_exact_match: true,
  }, query, queryWords, contentWords, weightedPhrases, idfMap, subjects, intents);

  assert.ok(scoredA, 'Doc A should be scored');
  assert.ok(scoredB, 'Doc B should be scored');

  // Title match MUST strictly outrank body-only match
  assert.ok(scoredA.totalScore > scoredB.totalScore, 'Doc with title topic match must strictly outrank body-only match');
  assert.ok(
    scoredEmbeddedQuestion.totalScore > scoredA.totalScore,
    'An exact stored question-to-answer match must outrank a merely topical title match'
  );
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

test('preserves Malayalam and Telugu query text instead of deleting native script', () => {
  assert.equal(
    distanceSearch.normalizeSpiritual('ദൈവത്തെ എങ്ങനെ അറിയാം?'),
    'ദൈവത്തെ എങ്ങനെ അറിയാം'
  );
  assert.equal(
    distanceSearch.normalizeSpiritual('దేవుణ్ణి ఎలా తెలుసుకోవాలి?'),
    'దేవుణ్ణి ఎలా తెలుసుకోవాలి'
  );
  assert.equal(
    distanceSearch.normalizeSearchQuery('ദൈവത്തെ എങ്ങനെ അറിയാം?').normalizedQuery,
    'ദൈവത്തെ എങ്ങനെ അറിയാം'
  );
});
