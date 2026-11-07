const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_RETRIEVAL_CHARACTERS,
  buildAnswerPassages,
  buildDiscoveryTexts,
  parseAnswerUnits,
  sha256,
  storyCompleteness,
} = require('../src/corpusStructure');

test('unmarked discourse is a complete Swami teaching even when its title is a question', () => {
  const text = 'Why fear?\n\nFear comes from attachment. Keep your duty before you.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:1', sourceType: 'discourse', question: 'Why fear?', text });
  assert.equal(parsed.ambiguities.length, 0);
  assert.deepEqual(parsed.units.map((unit) => unit.unitKind), ['swami_teaching']);
  assert.equal(parsed.units[0].text, text);
  assert.equal(parsed.units[0].author, 'Swami');
});

test('an introductory question note does not exclude an otherwise unmarked Swami teaching', () => {
  const text = '[Answers to questions sent by devotees.]\n\nThe teaching begins here and remains exact.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:old', sourceType: 'discourse', text, question: 'A title?' });
  assert.equal(parsed.ambiguities.length, 0);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].unitKind, 'swami_teaching');
  assert.equal(parsed.units[0].text, text);
});

test('a leading numbered question followed by an unmarked answer separates discovery from citation', () => {
  const text = '[Continuation of a question and answer session.]\n\n6. How can these philosophies be united?\n\nThe aim of the preacher is to uplift people.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:old-qa', sourceType: 'discourse', text, question: 'Philosophies' });
  assert.equal(parsed.ambiguities.length, 0);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].unitKind, 'swami_reply');
  assert.equal(parsed.units[0].associatedQuestion, '6. How can these philosophies be united?');
  assert.equal(parsed.units[0].text, 'The aim of the preacher is to uplift people.');
  assert.match(parsed.ignored[0].text, /How can these philosophies/u);
});

test('a bracketed asked-and-reply introduction starts the exact Swami reply after the note', () => {
  const text = '[Dr. Nikhil asked Swami about food. Swami gave the following message in reply.]\n\nEating food is one issue.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:intro-reply', sourceType: 'discourse', text, question: 'Food' });
  assert.equal(parsed.ambiguities.length, 0);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].unitKind, 'swami_reply');
  assert.equal(parsed.units[0].text, 'Eating food is one issue.');
});

test('Swami replied followed by a quotation mark is recognized without requiring a colon', () => {
  const text = '[A devotee asked a question.]\n\nSwami replied “Buddha was safe.”';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:quoted-reply', sourceType: 'discourse', text, question: 'Why?' });
  assert.equal(parsed.ambiguities.length, 0);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].text, '“Buddha was safe.”');
});

test('real corpus Original Message and New Reply headers separate Swami from devotee comments', () => {
  const text = 'Original Message of Shri Swami:\n\nExact first teaching.\n\nDr. Nikhil’s Comments on above Message:\n\nA devotee comment.\n\nNew Reply of Shri Datta Swami:\n\nExact second teaching.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:message-labels', sourceType: 'discourse', text });
  assert.equal(parsed.ambiguities.length, 0);
  assert.deepEqual(parsed.units.map((unit) => unit.text), ['Exact first teaching.', 'Exact second teaching.']);
  assert.match(parsed.ignored[0].text, /devotee comment/u);
});

test('Datta Swami disciple speech is citable while the separately labeled God-preacher speech is context', () => {
  const text = 'God-preacher Shri Datta spoke:-\n\nA separate speaker.\n\nDisciple of Datta (Datta Swami) spoke:-\n\nThe exact Swami passage.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:dialogue', sourceType: 'discourse', text });
  assert.equal(parsed.ambiguities.length, 0);
  assert.deepEqual(parsed.units.map((unit) => unit.text), ['The exact Swami passage.']);
  assert.match(parsed.ignored[0].text, /separate speaker/u);
});

test('explicit English questions are discovery context and only Swami replies are citable', () => {
  const text = 'A devotee asked: How should I work?\nSwami replied:- Work without attachment.\n\nKeep the result with God.\nAnother devotee asked: What about success?\nSwami: Do your duty. Success is not the measure.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:2', sourceType: 'discourse', text });
  assert.equal(parsed.units.length, 2);
  assert.equal(parsed.units[0].associatedQuestion, 'How should I work?');
  assert.equal(parsed.units[0].text, 'Work without attachment.\n\nKeep the result with God.');
  assert.equal(parsed.units[1].associatedQuestion, 'What about success?');
  assert.equal(parsed.units[1].text, 'Do your duty. Success is not the measure.');
  assert.ok(parsed.ignored.every((item) => item.role === 'devotee_question'));
});

test('numbered subquestions immediately before reply labels cannot leak into Swami units', () => {
  const text = 'a. Is duty important?\nSwami replied:- Yes, duty is important.\n\nb. Should its fruit be expected?\n\n[The devotee supplied additional context here.]\n\nSwami replied:- No. Leave the fruit to God.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:numbered', sourceType: 'discourse', text });
  assert.deepEqual(parsed.units.map((unit) => unit.associatedQuestion), ['a. Is duty important?', 'b. Should its fruit be expected?\n\n[The devotee supplied additional context here.]']);
  assert.deepEqual(parsed.units.map((unit) => unit.text), ['Yes, duty is important.', 'No. Leave the fruit to God.']);
});

test('Malayalam and Telugu labels produce separate exact Swami reply units', () => {
  const malayalam = 'ശ്രീ അനിൽ ചോദിച്ചു: എങ്ങനെ ജീവിക്കണം?\nസ്വാമി മറുപടി പറഞ്ഞു: സ്നേഹത്തോടെ ജീവിക്കുക.\nഫാദർ: നന്ദി.';
  const telugu = 'శ్రీ రామ్ అడిగిన ప్రశ్న: శాంతి ఎలా?\nస్వామి సమాధానము:- కోరికలను తగ్గించుకోండి.';
  const ml = parseAnswerUnits({ sourceId: 'discourse:3', sourceType: 'discourse', language: 'MAL', text: malayalam });
  const te = parseAnswerUnits({ sourceId: 'discourse:4', sourceType: 'discourse', language: 'TEL', text: telugu });
  assert.deepEqual(ml.units.map((unit) => unit.text), ['സ്നേഹത്തോടെ ജീവിക്കുക.']);
  assert.deepEqual(te.units.map((unit) => unit.text), ['కోరికలను తగ్గించుకోండి.']);
});

test('real translated-corpus Shri Swami and bracketed question labels preserve reply roles', () => {
  const malayalam = '[മിസ്സ്. ത്രൈലോക്യയുടെ ഒരു ചോദ്യം]\nശ്രീ സ്വാമി മറുപടി പറഞ്ഞു:- ആദ്യ ഉത്തരം.\n\n[ശ്രീ അനിലിന്റെ ഒരു ചോദ്യം]\nശ്രീ സ്വാമി മറുപടി പറഞ്ഞു:- രണ്ടാം ഉത്തരം.';
  const telugu = '[శ్రీ రామ్ ప్రశ్న]\nశ్రీ స్వామి సమాధానం:- కోరికలను తగ్గించుకోండి.';
  const ml = parseAnswerUnits({ sourceId: 'discourse:translated-ml', sourceType: 'discourse', language: 'MAL', text: malayalam });
  const te = parseAnswerUnits({ sourceId: 'discourse:translated-te', sourceType: 'discourse', language: 'TEL', text: telugu });
  assert.deepEqual(ml.units.map((unit) => unit.text), ['ആദ്യ ഉത്തരം.', 'രണ്ടാം ഉത്തരം.']);
  assert.deepEqual(te.units.map((unit) => unit.text), ['కోరికలను తగ్గించుకోండి.']);
});

test('a bracketed asked label does not leave its closing bracket in the associated question', () => {
  const text = '[Shri Hrushikesh asked: Does God protect a justified person?]\n\nSwami replied:- God judges whether the life is justified.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:bracket', sourceType: 'discourse', text });
  assert.equal(parsed.units[0].associatedQuestion, 'Does God protect a justified person?');
});

test('reply headers and diacritic Swami labels from the real corpus start citable replies', () => {
  const header = '[Reply of Swami to a question by Kum. M. Meenakshi]\nThe true preacher is identified through correct concepts.';
  const response = '[Dr. Nikhil asked: What is truth? Given below is Shri Swami’s response.]\nTruth survives analysis.';
  const diacritic = '[Mrs. Latha asked: How should I work?]\nSwāmi replied (via telephone): Work sincerely.';
  assert.deepEqual(parseAnswerUnits({ sourceId: 'd:header', sourceType: 'discourse', text: header }).units.map((unit) => unit.text), ['The true preacher is identified through correct concepts.']);
  assert.deepEqual(parseAnswerUnits({ sourceId: 'd:response', sourceType: 'discourse', text: response }).units.map((unit) => unit.text), ['Truth survives analysis.']);
  assert.deepEqual(parseAnswerUnits({ sourceId: 'd:diacritic', sourceType: 'discourse', text: diacritic }).units.map((unit) => unit.text), ['Work sincerely.']);
});

test('real corpus reply variants remain exact while becoming citable', () => {
  const header = '[Reply to a question by Shri PVNM Sharma] Govinda means the cowherd.';
  const typo = 'A devotee asked: How should I work?\nSwaami rerplied: Work sincerely.';
  const gita = '[Ms. Trailokya asked:- What is duty?]\n\nŚrī Dattasvāmī Uvāca:-\n\n2) Duty is divine.\n\n[Shri Dattaswami spoke:- Duty shall be done without aspiration.]';
  assert.deepEqual(parseAnswerUnits({ sourceId: 'd:reply-header', sourceType: 'discourse', text: header }).units.map((unit) => unit.text), ['Govinda means the cowherd.']);
  assert.deepEqual(parseAnswerUnits({ sourceId: 'd:reply-typo', sourceType: 'discourse', text: typo }).units.map((unit) => unit.text), ['Work sincerely.']);
  assert.deepEqual(parseAnswerUnits({ sourceId: 'd:gita', sourceType: 'discourse', text: gita }).units.map((unit) => unit.text), ['2) Duty is divine.\n\n[Shri Dattaswami spoke:- Duty shall be done without aspiration.]']);
});

test('rhetorical questions remain inside a Swami teaching', () => {
  const text = 'What is the use of wealth without peace? Serve others and remain peaceful.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:5', sourceType: 'discourse', text });
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].text, text);
});

test('speaker-marked discourse without a recognized Swami transition is excluded for review', () => {
  const parsed = parseAnswerUnits({
    sourceId: 'discourse:6',
    sourceType: 'discourse',
    text: 'Devotee: Please guide me.\nFather: We should wait.',
  });
  assert.equal(parsed.units.length, 0);
  assert.equal(parsed.ambiguities.length, 1);
});

test('QA answer text remains exact and defaults its author to Swami', () => {
  const text = 'Swami replied: Do the work.  Do not alter these spaces.';
  const parsed = parseAnswerUnits({ sourceId: 'qa:7', sourceType: 'qa', question: 'What should I do?', text });
  assert.equal(parsed.units[0].text, text);
  assert.equal(parsed.units[0].contentHash, sha256(text));
  assert.equal(parsed.units[0].author, 'Swami');
});

test('an explicit non-Swami byline is withheld rather than defaulted to Swami', () => {
  const text = '[By Dr. Nikhil]\n\nI received an unexpected promotion and describe my experience.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:experience', sourceType: 'discourse', question: 'Divine Experiences', text });
  assert.equal(parsed.units.length, 0);
  assert.equal(parsed.ambiguities.length, 1);
});

test('document authorship does not leak into an explicitly labeled Swami reply unit', () => {
  const text = '[By Dr. Devotee]\n\nA personal introduction.\n\nSwami replied: Exact teaching.';
  const parsed = parseAnswerUnits({
    sourceId: 'discourse:mixed-author', sourceType: 'discourse', text, author: 'Dr. Devotee',
  });
  assert.equal(parsed.author, 'Dr. Devotee');
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].author, 'Swami');
  assert.equal(parsed.units[0].text, 'Exact teaching.');
  assert.ok(parsed.ignored.some((span) => /personal introduction/u.test(span.text)));
});

test('retrieval windows can overlap internally but citations expand to an exact paragraph', () => {
  const paragraph = Array.from({ length: 20 }, (_, index) => `Sentence ${index + 1} is unchanged.`).join(' ');
  const parsed = parseAnswerUnits({ sourceId: 'discourse:8', sourceType: 'discourse', text: paragraph });
  const passages = buildAnswerPassages(paragraph, parsed.units, { maxCharacters: 100 });
  assert.ok(passages.length > 1);
  for (const passage of passages) {
    assert.equal(paragraph.slice(passage.start, passage.end), passage.text);
    assert.equal(paragraph.slice(passage.citationStart, passage.citationEnd), passage.citationText);
    assert.equal(passage.citationText, paragraph);
  }
});

test('exceptionally long single sentences and discovery context are bounded for embedding', () => {
  const sentence = `Teaching ${'word '.repeat(900).trim()}.`;
  const parsed = parseAnswerUnits({ sourceId: 'discourse:long-sentence', sourceType: 'discourse', text: sentence });
  const passages = buildAnswerPassages(sentence, parsed.units);
  assert.ok(passages.length > 1);
  assert.ok(passages.every((passage) => passage.text.length <= MAX_RETRIEVAL_CHARACTERS));
  assert.ok(passages.every((passage) => passage.citationText === sentence));

  const discovery = buildDiscoveryTexts({
    sourceId: 'discourse:long-discovery', question: sentence, answer: sentence, metadata: {},
  }, { units: [], ignored: [] });
  assert.ok(discovery.length > 1);
  assert.ok(discovery.every((item) => item.text.length <= MAX_RETRIEVAL_CHARACTERS));
});

test('story windows are incomplete unless a consequence or stated lesson is present', () => {
  assert.equal(storyCompleteness('Once a man went to a village.'), false);
  assert.equal(storyCompleteness('Once a man went to a village. Thus, duty is more important than reward.'), true);
  assert.equal(storyCompleteness('Do your duty without attachment.'), true);
});

test('headings and translator notes remain discovery context but cannot be cited', () => {
  const text = '48) God is Omnipotent and Omniscient:-\n\n[Translated by devotees of Swami]\n\n[Translator note: The source preserves this term.]\n\nAsk God only for what is good for you.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:9', sourceType: 'discourse', question: 'Prayer', text });
  const passages = buildAnswerPassages(text, parsed.units);
  assert.deepEqual(passages.map((passage) => passage.text), ['Ask God only for what is good for you.']);
  const discovery = buildDiscoveryTexts({ sourceId: 'discourse:9', question: 'Prayer', answer: text, metadata: {} }, parsed);
  assert.ok(discovery.some((item) => item.text.startsWith('48) God is')));
  assert.ok(discovery.some((item) => item.text.startsWith('[Translated by')));
  assert.ok(discovery.some((item) => item.text.startsWith('[Translator note:')));
});

test('named non-Swami speaker transitions cannot leak into the preceding reply', () => {
  const text = 'Devotee asked: What is duty?\nSwami replied:- Do the right action.\nDr. Rao: Thank you.\nSwami replied:- Leave the fruit to God.';
  const parsed = parseAnswerUnits({ sourceId: 'discourse:10', sourceType: 'discourse', text });
  assert.deepEqual(parsed.units.map((unit) => unit.text), ['Do the right action.', 'Leave the fruit to God.']);
  assert.ok(parsed.ignored.some((item) => item.text === 'Thank you.'));
});
