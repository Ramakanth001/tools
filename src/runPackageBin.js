#!/usr/bin/env node
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const rootDir = path.resolve(__dirname, '..');
const [packageName, ...args] = process.argv.slice(2);

if (!packageName) {
  console.error('Usage: node src/runPackageBin.js <package> [...args]');
  process.exit(1);
}

function candidateBases() {
  return Array.from(new Set([
    process.cwd(),
    rootDir,
    path.join(rootDir, 'pg-backup'),
    path.join(rootDir, 'mysql-tool'),
    path.join(rootDir, 'mysql-pg-migrate'),
    path.join(rootDir, 'semantic-qa'),
    path.join(rootDir, 'transcriber'),
  ]));
}

function resolveBin() {
  for (const base of candidateBases()) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      const packageJsonPath = req.resolve(`${packageName}/package.json`);
      const packageJson = require(packageJsonPath);
      const bin = typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.[packageName] || Object.values(packageJson.bin || {})[0];
      if (!bin) continue;
      return path.resolve(path.dirname(packageJsonPath), bin);
    } catch {
      // Try the next local dependency root.
    }
  }
  return null;
}

const binPath = resolveBin();
if (!binPath) {
  console.error(`Unable to resolve local package binary for ${packageName}. Run npm install for this project.`);
  process.exit(127);
}

const result = spawnSync(process.execPath, [binPath, ...args], { stdio: 'inherit', cwd: process.cwd() });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
