const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const value = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(value) : /\.(js|jsx|mjs)$/u.test(entry.name) ? [value] : [];
  });
}

test('GPT has no source dependency or API call into Search Engine or Deep Summary', () => {
  for (const file of sourceFiles(path.resolve(__dirname, '../src'))) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /semantic-qa\/src|\/api\/tools\/semantic-qa|deepSummaryManager|semanticSummary/iu, file);
  }
});
