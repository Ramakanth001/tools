const path = require('node:path');
const { createRequire } = require('node:module');

const localRequire = createRequire(path.resolve(__dirname, './package.json'));
const migrationRequire = createRequire(path.resolve(__dirname, '../mysql-pg-migrate/package.json'));
const sharedRequire = createRequire(path.resolve(__dirname, '../pg-backup/package.json'));

function requireToolDep(name) {
  for (const loader of [localRequire, migrationRequire, sharedRequire]) {
    try {
      return loader(name);
    } catch {
      // Try the next package's dependencies.
    }
  }
  return localRequire(name);
}

function resolveToolDep(name) {
  for (const loader of [localRequire, migrationRequire, sharedRequire]) {
    try {
      return loader.resolve(name);
    } catch {
      // Try the next package's dependencies.
    }
  }
  return localRequire.resolve(name);
}

module.exports = { requireToolDep, resolveToolDep };
