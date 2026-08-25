const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseDefault, passesAbsolute } = require('../scripts/benchmarkModels');

function passing(overrides = {}) {
  return {
    sourceRecall: 0.96, correctAbstention: 0.96, citationSpanValidity: 1,
    groundedCorrectness: 0.94, citationSupport: 0.98, unsupportedClaimRate: 0.01,
    latencyMs: { median: 30000, p95: 50000, complexP95: 80000, retrievalP95: 1200 },
    memory: { peakUsedBytes: 16_000_000_000, swapGrowthBytes: 500_000_000 },
    ...overrides,
  };
}

test('absolute gates include retrieval, end-to-end latency, and swap growth', () => {
  assert.equal(passesAbsolute(passing()), true);
  assert.equal(passesAbsolute(passing({ latencyMs: { median: 30000, p95: 50000, complexP95: 80000, retrievalP95: 1600 } })), false);
  assert.equal(passesAbsolute(passing({ memory: { peakUsedBytes: 16_000_000_000, swapGrowthBytes: 2_000_000_000 } })), false);
});

test('Q4 is selected only when quality stays close and it saves at least twenty percent', () => {
  const q8 = passing();
  const q4 = passing({ groundedCorrectness: 0.935, unsupportedClaimRate: 0.014,
    latencyMs: { median: 22000, p95: 49000, complexP95: 78000, retrievalP95: 1100 },
    memory: { peakUsedBytes: 12_000_000_000, swapGrowthBytes: 300_000_000 } });
  assert.equal(chooseDefault(q4, q8), 'qwen3:14b-q4_K_M');
  assert.equal(chooseDefault(passing({ groundedCorrectness: 0.91 }), q8), 'qwen3:14b-q8_0');
});
