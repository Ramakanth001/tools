const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGates } = require('../scripts/generateDeepSearchQualityReport');

function makeValidRawReport() {
  return {
    executedCases: 50,
    completeBenchmarkRun: true,
    summary: {
      candidateRecall: 0.96,
      evidenceRecall: 0.92,
      evidencePrecision: 0.91,
      forbiddenEvidenceRate: 0.0,
      answerStatusAccuracy: 0.94,
      abstentionAccuracy: 1.0,
      exactEvidenceRate: 1.0,
      citationPassRate: 1.0,
      citationsChecked: 95,
      citationsPassed: 95,
      citationsFailed: 0,
      casesWithEvidence: 38,
      casesWithoutEvidence: 12,
    },
    results: [
      {
        id: 'seed-datta-swami',
        actualAnswerStatus: 'direct',
        evidenceAnswerUnitIds: ['discourse:738:teaching:1'],
        forbiddenEvidenceRate: 0,
        latencyMs: 1500,
        exactEvidence: true,
        citationsChecked: 1,
        citationsPassed: 1,
        citationsFailed: 0,
      },
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `negative-unanswerable-${i}`,
        category: 'unanswerable',
        expectedAnswerStatus: 'insufficient',
        actualAnswerStatus: 'insufficient',
        abstentionCorrect: true,
        latencyMs: 1200,
        exactEvidence: null,
        citationsChecked: 0,
        citationsPassed: 0,
        citationsFailed: 0,
      })),
      ...Array.from({ length: 42 }, (_, i) => ({
        id: `case-pos-${i}`,
        category: 'direct',
        expectedAnswerStatus: 'direct',
        actualAnswerStatus: 'direct',
        latencyMs: 1400,
        exactEvidence: true,
        citationsChecked: 2,
        citationsPassed: 2,
        citationsFailed: 0,
      })),
    ],
  };
}

function makeValidAuditReport() {
  return {
    success: true,
    totalRecordsAudited: 6010,
    nonSwamiCitableUnitsCreated: 0,
    databaseIndexAudit: {
      totalAnswerUnitsInDb: 11351,
      nonSwamiBylineUnitsInDb: [],
      offsetMismatchCount: 0,
      contentHashMismatchCount: 0,
    },
  };
}

test('Quality report gates: passes when all metrics and audits meet contract', () => {
  const rawReport = makeValidRawReport();
  const auditReport = makeValidAuditReport();
  const { gates, allPassed } = evaluateGates(rawReport, auditReport);

  assert.equal(allPassed, true);
  for (const g of gates) {
    assert.equal(g.passed, true, `Gate ${g.gate} was expected to pass`);
  }
});

test('Quality report gates: Gate 1 fails on incomplete execution', () => {
  const rawReport = makeValidRawReport();
  rawReport.executedCases = 49;
  rawReport.completeBenchmarkRun = false;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate1 = gates.find((g) => g.gate.startsWith('1.'));
  assert.equal(gate1.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 2 fails on exact evidence mismatch or failed citations', () => {
  const rawReport = makeValidRawReport();
  rawReport.summary.exactEvidenceRate = 0.98;
  rawReport.summary.citationPassRate = 0.98;
  rawReport.results[0].exactEvidence = false;
  rawReport.results[0].citationsFailed = 1;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate2 = gates.find((g) => g.gate.startsWith('2.'));
  assert.equal(gate2.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 3 fails on forbidden evidence citations', () => {
  const rawReport = makeValidRawReport();
  rawReport.summary.forbiddenEvidenceRate = 0.05;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate3 = gates.find((g) => g.gate.startsWith('3.'));
  assert.equal(gate3.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 4 fails when candidate recall < 0.95', () => {
  const rawReport = makeValidRawReport();
  rawReport.summary.candidateRecall = 0.81;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate4 = gates.find((g) => g.gate.startsWith('4.'));
  assert.equal(gate4.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 5 fails when evidence recall < 0.90', () => {
  const rawReport = makeValidRawReport();
  rawReport.summary.evidenceRecall = 0.50;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate5 = gates.find((g) => g.gate.startsWith('5.'));
  assert.equal(gate5.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 6 evaluates evidencePrecision (not recall)', () => {
  const rawReport = makeValidRawReport();
  rawReport.summary.evidenceRecall = 0.95; // recall is high
  rawReport.summary.evidencePrecision = 0.31; // precision is low
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate6 = gates.find((g) => g.gate.startsWith('6.'));
  assert.equal(gate6.passed, false, 'Gate 6 must fail when precision is 0.31 even if recall is 0.95');
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 7 fails when answer status accuracy < 0.90', () => {
  const rawReport = makeValidRawReport();
  rawReport.summary.answerStatusAccuracy = 0.24;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate7 = gates.find((g) => g.gate.startsWith('7.'));
  assert.equal(gate7.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 8 fails when unanswerable abstention < 7', () => {
  const rawReport = makeValidRawReport();
  // Mark 2 of the 7 negative cases as abstentionCorrect = false
  rawReport.results[1].abstentionCorrect = false;
  rawReport.results[2].abstentionCorrect = false;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate8 = gates.find((g) => g.gate.startsWith('8.'));
  assert.equal(gate8.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 9 fails if seed-datta-swami does not cite primary teaching or returns related', () => {
  const rawReport = makeValidRawReport();
  const seed = rawReport.results.find((r) => r.id === 'seed-datta-swami');
  seed.actualAnswerStatus = 'related_teachings';
  const auditReport = makeValidAuditReport();

  const { gates, allPassed } = evaluateGates(rawReport, auditReport);
  const gate9 = gates.find((g) => g.gate.startsWith('9.'));
  assert.equal(gate9.passed, false);
  assert.equal(allPassed, false);
});

test('Quality report gates: Gate 10 fails if candidate authorship audit is missing or failed', () => {
  const rawReport = makeValidRawReport();
  const failingAudit = makeValidAuditReport();
  failingAudit.success = false;
  failingAudit.nonSwamiCitableUnitsCreated = 2;

  const { gates: gatesNoAudit } = evaluateGates(rawReport, null);
  const gate10NoAudit = gatesNoAudit.find((g) => g.gate.startsWith('10.'));
  assert.equal(gate10NoAudit.passed, false);

  const { gates: gatesFailedAudit } = evaluateGates(rawReport, failingAudit);
  const gate10FailedAudit = gatesFailedAudit.find((g) => g.gate.startsWith('10.'));
  assert.equal(gate10FailedAudit.passed, false);
});

test('Quality report gates: Gate 11 fails if any case experiences a timeout or crash', () => {
  const rawReport = makeValidRawReport();
  rawReport.results[5].timedOut = true;
  const auditReport = makeValidAuditReport();

  const { gates, allPassed, timeoutOrCrashCases } = evaluateGates(rawReport, auditReport);
  const gate11 = gates.find((g) => g.gate.startsWith('11.'));
  assert.equal(gate11.passed, false);
  assert.equal(timeoutOrCrashCases.length, 1);
  assert.equal(allPassed, false);
});
