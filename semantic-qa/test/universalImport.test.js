const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiscourseRecords, buildRecords, chunkText, htmlToPlainText } = require('../scripts/importUniversalQa');

test('legacy HTML becomes readable plain text without rewriting words', () => {
  assert.equal(
    htmlToPlainText('<p><strong>Swami replied:-</strong>&nbsp;Use clarity &amp; logic in the caf&eacute;.</p><p>Next point.</p>'),
    'Swami replied:- Use clarity & logic in the café.\n\nNext point.',
  );
});

test('long answers become ordered chunks under the configured character limit', () => {
  const chunks = chunkText(`${'first '.repeat(70)}\n\n${'second '.repeat(70)}`, 300);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.ok(chunks[0].startsWith('first'));
  assert.ok(chunks.at(-1).includes('second'));
});

test('import records retain source identity and chunk ordering', () => {
  const { records, rejected } = buildRecords([{
    qaId: 52,
    masterId: 388,
    title: 'What is clarity?',
    briefQuestion: '<p>Please explain.</p>',
    questionBk: '',
    recordDate: '2025-02-10 14:12:20',
    multimediaFilename: 'ENG_',
    answerBySwami: `<p>${'Clarity is knowledge. '.repeat(30)}</p>`,
    masterLanguage: 'ENG',
  }], 300);
  assert.deepEqual(rejected, []);
  assert.ok(records.length > 1);
  assert.equal(records[0].sourceId, 'qa:52:001');
  assert.equal(records[0].originalRecordId, 52);
  assert.equal(records[0].sourceContext, 'Please explain.');
  assert.equal(records.at(-1).chunkIndex, records.length);
  assert.equal(records.at(-1).chunkCount, records.length);
});

test('discourse records use language-aware chunks and distinct source identities', () => {
  const { records, rejected } = buildDiscourseRecords([{
    dcId: 66,
    masterId: 115,
    title: 'BOOK OF SPIRITUALITY',
    summary: '<p>Opening discourse.</p>',
    textDC: `<p>${'Divine knowledge. '.repeat(80)}</p>`,
    recordDate: '2010-01-01 00:00:00',
    multimediaFilename: 'ENG_',
    masterLanguage: 'ENG',
  }], { englishMaxChars: 400, otherMaxChars: 250 });
  assert.deepEqual(rejected, []);
  assert.ok(records.length > 1);
  assert.equal(records[0].sourceId, 'discourse:66:001');
  assert.equal(records[0].sourceType, 'discourse');
  assert.equal(records[0].sourceGroup, 'discourse:66');
  assert.equal(records[0].sourceContext, 'Opening discourse.');
  assert.ok(records.every((record) => record.answer.length <= 400));
});
