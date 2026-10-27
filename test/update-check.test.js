const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lookupLatestVersion, warnIfOutdated } = require('../lib/update-check');
const { runCli } = require('..');

function fakeRegistry({ body = '{"version":"1.2.3"}', status = 200, error, hang = false } = {}) {
  const request = new EventEmitter();
  request.destroy = () => { request.destroyed = true; };
  const response = new PassThrough();
  response.statusCode = status;
  return { request, response, get(url, options, callback) {
    assert.equal(url, 'https://registry.npmjs.org/catchmydrift/latest');
    assert.equal(options.headers.Accept, 'application/json');
    process.nextTick(() => {
      if (error) request.emit('error', error);
      else if (!hang) {
        callback(response);
        response.end(body);
      }
    });
    return request;
  } };
}

function output() {
  let value = '';
  return { write: chunk => { value += chunk; }, get value() { return value; } };
}

test('registry lookup reads a validated release and closes the request', async () => {
  const registry = fakeRegistry();
  assert.equal(await lookupLatestVersion({ get: registry.get }), '1.2.3');
  assert.equal(registry.request.destroyed, true);
});

test('registry failures, invalid data, oversized bodies, and redirects are ignored', async () => {
  for (const scenario of [
    { status: 503 }, { status: 302 }, { body: 'invalid JSON' },
    { body: 'null' }, { body: '{}' }, { body: '{"version":42}' },
    { body: '{"version":"not-a-version"}' },
    { body: '{"version":"1.2.3\\nmalicious text"}' },
    { body: 'x'.repeat(65537) }, { error: new Error('offline') }
  ]) {
    const registry = fakeRegistry(scenario);
    assert.equal(await lookupLatestVersion({ get: registry.get }), null);
    assert.equal(registry.request.destroyed, true);
  }
  assert.equal(await lookupLatestVersion({ get() { throw new Error('unavailable'); } }), null);
});

test('wall-clock deadline cancels stalled connection and response body', async () => {
  const registry = fakeRegistry({ hang: true });
  assert.equal(await lookupLatestVersion({ get: registry.get, timeoutMs: 10 }), null);
  assert.equal(registry.request.destroyed, true);
  const slow = fakeRegistry({ hang: true });
  assert.equal(await lookupLatestVersion({ timeoutMs: 10, get(url, options, callback) {
    process.nextTick(() => callback(slow.response));
    return slow.request;
  } }), null);
  assert.equal(slow.response.destroyed, true);
});

test('only newer releases warn, using semantic version ordering', async () => {
  for (const [installed, latest, warns] of [
    ['1.2.3', '1.2.3', false], ['2.0.0', '1.9.9', false],
    ['1.9.0', '1.10.0', true], ['1.0.0-beta.1', '1.0.0', true],
    ['1.0.0', '1.0.0-beta.1', false], ['1.0.0+build', '1.0.0', false],
    ['1.0.0', null, false], ['1.0.0', 'bad', false]
  ]) {
    const stderr = output();
    await warnIfOutdated({ installedVersion: installed, stderr, env: {}, lookup: async () => latest });
    assert.equal(stderr.value.includes('warning:'), warns);
    if (warns) {
      assert.ok(stderr.value.includes(`installed version ${installed}; latest version ${latest}`));
      assert.match(stderr.value, /npm install --save-dev catchmydrift@latest/);
      assert.match(stderr.value, /npm install --global catchmydrift@latest/);
      assert.match(stderr.value, /npx catchmydrift@latest/);
    }
  }
});

test('CI and explicit opt-out avoid registry requests', async () => {
  for (const env of [{ CI: 'true' }, { CI: '1' }, { CATCHMYDRIFT_NO_UPDATE_CHECK: '1' }]) {
    let calls = 0;
    await warnIfOutdated({ installedVersion: '1.0.0', stderr: output(), env,
      lookup: async () => { calls++; return null; } });
    assert.equal(calls, 0);
  }
  for (const env of [{}, { CI: 'false' }, { CI: '0' }, { CI: '' }]) {
    let calls = 0;
    await warnIfOutdated({ installedVersion: '1.0.0', stderr: output(), env,
      lookup: async () => { calls++; return null; } });
    assert.equal(calls, 1);
  }
});

test('help, version, and invalid usage stay offline', async () => {
  for (const args of [['--help'], ['--version'], ['review', '--help'], ['--bad-option']]) {
    let calls = 0;
    await runCli(args, { stdout: output(), stderr: output(), env: {},
      lookupLatestVersion: async () => { calls++; return null; } });
    assert.equal(calls, 0);
  }
});

test('warnings preserve check and review results in a real repository', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-update-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Readme\n');
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'before\n');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'fixture']);
  const options = () => ({ cwd, stdout: output(), stderr: output(), env: {},
    lookupLatestVersion: async () => '999.0.0' });
  const healthy = options();
  assert.equal(await runCli([], healthy), 0);
  assert.match(healthy.stdout.value, /Healthy:/);
  assert.match(healthy.stderr.value, /warning:/);
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'after\n');
  const drift = options();
  assert.equal(await runCli(['check'], drift), 1);
  assert.match(drift.stderr.value, /warning:/);
  assert.equal(await runCli(['review', 'README.md'], options()), 2);
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'source change']);
  const approved = options();
  assert.equal(await runCli(['review', 'README.md'], approved), 0);
  assert.match(approved.stdout.value, /Approved: README.md/);
  assert.match(approved.stderr.value, /warning:/);
  assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), '# Readme\n');
  const offline = options();
  offline.lookupLatestVersion = async () => { throw new Error('offline'); };
  assert.equal(await runCli([], offline), 0);
  assert.equal(offline.stderr.value, '');
  assert.equal(git(['status', '--porcelain']).toString(), '?? .catchmydrift-state.json\n');
});
