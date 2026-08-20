const test = require('node:test');
const assert = require('node:assert/strict');

const { createProgressReader } = require('../src/runner');

test('progress reader publishes carriage-return status before process close', async () => {
  const lines = [];
  const reader = createProgressReader((line) => lines.push(line), { intervalMs: 5 });

  reader.push(Buffer.from('Downloading model: 42%\r'));
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(lines, ['Downloading model: 42%']);
  reader.flush();
});

test('progress reader coalesces rapid terminal redraws and preserves normal lines', async () => {
  const lines = [];
  const reader = createProgressReader((line) => lines.push(line), { intervalMs: 25 });

  reader.push(Buffer.from('0%\r25%\r50%\r'));
  await new Promise((resolve) => setTimeout(resolve, 35));
  reader.push(Buffer.from('worker warning\n'));

  assert.deepEqual(lines, ['0%', '50%', 'worker warning']);
  reader.flush();
});
