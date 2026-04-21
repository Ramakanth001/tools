const path = require('node:path');
const { createRequire } = require('node:module');

const localRequire = createRequire(path.resolve(__dirname, './package.json'));
const sharedRequire = createRequire(path.resolve(__dirname, '../pg-backup/package.json'));

function requireToolDep(name) {
  try {
    return localRequire(name);
  } catch {
    return sharedRequire(name);
  }
}

module.exports = { requireToolDep };
