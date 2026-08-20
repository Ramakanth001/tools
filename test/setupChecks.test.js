const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { evaluateRequirements, createSetupChecker } = require('../src/setupChecks');

async function fixture() {
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tools-setup-check-'));
  const toolDir = path.join(workspaceDir, 'demo');
  await fsp.mkdir(toolDir);
  await fsp.writeFile(path.join(toolDir, 'package.json'), JSON.stringify({ dependencies: {} }));
  return { workspaceDir, toolDir };
}

test('required failures make a tool not ready and retain the fix', async (t) => {
  const dirs = await fixture();
  t.after(() => fsp.rm(dirs.workspaceDir, { recursive: true, force: true }));

  const result = await evaluateRequirements({
    toolId: 'demo',
    checks: [
      { id: 'packages', type: 'node-packages', label: 'Node packages' },
      { id: 'binary', type: 'command', command: 'missing', label: 'Helper', fix: 'Install helper' },
    ],
  }, {
    ...dirs,
    runCommand: async () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; },
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks[0].ok, true);
  assert.equal(result.checks[1].ok, false);
  assert.equal(result.checks[1].fix, 'Install helper');
});

test('optional failures do not block readiness', async (t) => {
  const dirs = await fixture();
  t.after(() => fsp.rm(dirs.workspaceDir, { recursive: true, force: true }));

  const result = await evaluateRequirements({
    toolId: 'demo',
    checks: [{ id: 'optional', type: 'command', command: 'optional', required: false }],
  }, {
    ...dirs,
    runCommand: async () => { throw new Error('unavailable'); },
  });

  assert.equal(result.ready, true);
  assert.equal(result.checks[0].ok, false);
  assert.equal(result.checks[0].required, false);
});

test('the setup checker only reads allowlisted tool requirement files', async (t) => {
  const dirs = await fixture();
  t.after(() => fsp.rm(dirs.workspaceDir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dirs.toolDir, 'setup.requirements.json'), JSON.stringify({
    toolId: 'demo',
    setupCommand: 'npm --prefix ./demo install',
    checks: [{ id: 'packages', type: 'node-packages' }],
  }));

  const check = createSetupChecker({ workspaceDir: dirs.workspaceDir, toolIds: ['demo'] });
  const result = await check('demo');
  assert.equal(result.ready, true);
  assert.equal(result.requirementsFile, 'demo/setup.requirements.json');
  await assert.rejects(() => check('../demo'), /Unknown tool/);
});
