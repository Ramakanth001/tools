const path = require('node:path');
const { createRequire } = require('node:module');

const loaders = [
  createRequire(path.resolve(__dirname, './package.json')),
  createRequire(path.resolve(__dirname, '../semantic-qa/package.json')),
  createRequire(path.resolve(__dirname, '../pg-backup/package.json')),
];

function requireToolDep(name) {
  for (const loader of loaders) {
    try { return loader(name); } catch { /* Try the next local package. */ }
  }
  return loaders[0](name);
}

function resolveToolDep(name) {
  for (const loader of loaders) {
    try { return loader.resolve(name); } catch { /* Try the next local package. */ }
  }
  return loaders[0].resolve(name);
}

module.exports = { requireToolDep, resolveToolDep };
