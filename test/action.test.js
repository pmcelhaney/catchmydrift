'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { check } = require('../index');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-action-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(root, 'README.md'), 'Timeout is 10 seconds.\n');
  fs.writeFileSync(path.join(root, 'code.js'), 'const timeout = 10;\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(root, 'code.js'), 'const timeout = 20;\n');
  git('add', '.'); git('commit', '-qm', 'change');
  return { root, git, baseline };
}

function consumer(t, root) {
  const runner = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-action-runner-'));
  t.after(() => fs.rmSync(runner, { recursive: true, force: true }));
  const installed = path.join(runner, 'installed-action');
  fs.cpSync(path.join(__dirname, '../dist'), installed, { recursive: true });
  const output = path.join(runner, 'outputs'); const summary = path.join(runner, 'summary');
  const env = { ...process.env, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: runner, INPUT_ROOT: '.', INPUT_CONFIG: '',
    INPUT_THRESHOLD: '', 'INPUT_FAIL-ON-DRIFT': 'false' };
  return {
    run(inputs = {}) {
      fs.writeFileSync(output, ''); fs.writeFileSync(summary, '');
      return spawnSync(process.execPath, [path.join(installed, 'index.js')], {
        cwd: root, env: { ...env, ...inputs }, encoding: 'utf8'
      });
    },
    output: () => fs.readFileSync(output, 'utf8'),
    summary: () => fs.readFileSync(summary, 'utf8'),
    report() {
      const directory = this.output().match(/report-directory<<[^\n]+\n([^\n]+)/)[1];
      assert.deepEqual(fs.readdirSync(directory), ['report.json']);
      return JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
    }
  };
}

test('bundled Action runs without node_modules, reports drift and leaves tracked files and review state untouched', t => {
  const { root, git, baseline } = fixture(t);
  const state = JSON.stringify({ 'README.md': baseline });
  fs.writeFileSync(path.join(root, '.catchmydrift-state.json'), state);
  const before = git('status', '--porcelain');
  const action = consumer(t, root); const result = action.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(action.output(), /drift-detected<<.*\ntrue\n/);
  assert.deepEqual(action.report(), { driftDetected: true, results: [
    { watchedPath: 'README.md', baseline, percent: 100, threshold: 20, missing: false }
  ] });
  assert.match(action.summary(), /Drift detected: true/);
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(fs.readFileSync(path.join(root, '.catchmydrift-state.json'), 'utf8'), state);
  assert.equal(action.run({ 'INPUT_FAIL-ON-DRIFT': 'true' }).status, 1);
  assert.equal(action.run({ INPUT_THRESHOLD: '100', 'INPUT_FAIL-ON-DRIFT': 'true' }).status, 0);
  assert.equal(action.report().driftDetected, false);
});

test('shallow checkout fails with fetch-depth instructions; fetching full history restores the original baseline', t => {
  const { root, baseline } = fixture(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-action-clone-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const clone = path.join(parent, 'checkout');
  execFileSync('git', ['clone', '-q', '--depth=1', pathToFileURL(root).href, clone]);
  const action = consumer(t, clone); const result = action.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /requires full Git history.*fetch-depth: 0/);
  assert.equal(action.output(), '');
  execFileSync('git', ['fetch', '-q', '--unshallow'], { cwd: clone });
  const full = action.run();
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.equal(action.report().results[0].baseline, baseline);
  assert.equal(action.report().driftDetected, true);
});

test('Action rejects a scan root outside the workspace', t => {
  const { root } = fixture(t); const action = consumer(t, root);
  assert.equal(action.run({ INPUT_ROOT: '..' }).status, 1);
  assert.equal(action.output(), '');
});

test('analysis never runs configured external diff or text conversion commands', t => {
  const { root, git } = fixture(t);
  const marker = path.join(root, 'executed');
  git('config', 'diff.external', `touch ${marker}`);
  git('config', 'diff.evil.textconv', `touch ${marker}`);
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.js diff=evil\n');
  git('add', '.gitattributes'); git('commit', '-qm', 'attributes');
  assert.equal(check(root).failed, true);
  assert.equal(fs.existsSync(marker), false);
});
