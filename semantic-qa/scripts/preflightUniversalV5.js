const assert = require('node:assert/strict');
const database = require('../src/database');
const {
  MAX_RETRIEVAL_CHARACTERS,
  buildAnswerPassages,
  buildDiscoveryTexts,
  parseAnswerUnits,
} = require('../src/corpusStructure');
const { mapping, sourceConnection } = require('./universalV5Config');

async function run() {
  const snapshot = await database.openSourceSnapshot(sourceConnection, mapping);
  const audit = { documents: 0, answerUnits: 0, answerPassages: 0, discoveryPassages: 0, ambiguousDocuments: 0 };
  try {
    for (let offset = 0; offset < snapshot.total; offset += 250) {
      const records = await snapshot.readBatch(offset, 250);
      for (const record of records) {
        const questionContext = String(record.metadata?.question_context || record.metadata?.source_context || '').trim();
        const parsed = parseAnswerUnits({
          sourceId: record.sourceId,
          sourceType: record.metadata?.source_type || '',
          question: [record.question, questionContext].filter(Boolean).join('\n\n'),
          text: record.answer,
          language: record.metadata?.language || '',
          author: record.metadata?.author || '',
        });
        if (parsed.ambiguities.length) audit.ambiguousDocuments += 1;
        for (const unit of parsed.units) {
          assert.equal(unit.author, 'Swami', `${unit.answerUnitId} has a non-Swami citable author`);
          assert.equal(record.answer.slice(unit.start, unit.end), unit.text, `${unit.answerUnitId} has invalid offsets`);
        }
        const passages = buildAnswerPassages(record.answer, parsed.units);
        for (const passage of passages) {
          assert.ok(passage.text.length <= MAX_RETRIEVAL_CHARACTERS, `${record.sourceId} has an oversized answer embedding`);
          assert.equal(record.answer.slice(passage.start, passage.end), passage.text, `${record.sourceId} has invalid passage offsets`);
          assert.equal(record.answer.slice(passage.citationStart, passage.citationEnd), passage.citationText, `${record.sourceId} has invalid citation offsets`);
        }
        const discovery = buildDiscoveryTexts(record, parsed);
        assert.ok(discovery.every((item) => item.text.length <= MAX_RETRIEVAL_CHARACTERS), `${record.sourceId} has oversized discovery text`);
        audit.documents += 1;
        audit.answerUnits += parsed.units.length;
        audit.answerPassages += passages.length;
        audit.discoveryPassages += discovery.length;
      }
    }
    await snapshot.close(true);
  } catch (error) {
    await snapshot.close(false).catch(() => undefined);
    throw error;
  }
  assert.equal(audit.documents, snapshot.total, 'Preflight did not scan the full snapshot');
  process.stdout.write(`${JSON.stringify({ ok: true, ...audit }, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
