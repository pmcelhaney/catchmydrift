'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { check } = require('../index');
const { buildContext, validateReview, requestReview, LIMITS } = require('../action/review');
const { eventPolicy } = require('../action/main');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-action-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(root, 'README.md'), 'Timeout is 10 seconds.\n');
  fs.writeFileSync(path.join(root, 'code.js'), 'const timeout = 10;\n');
  fs.writeFileSync(path.join(root, 'private.txt'), 'do not send this');
  git('add', '.'); git('commit', '-qm', 'baseline');
  fs.writeFileSync(path.join(root, 'code.js'), 'const timeout = 20;\n');
  git('add', '.'); git('commit', '-qm', 'change');
  return { root, git };
}
const mismatch = { status: 'mismatch', explanation: 'Timeout changed from 10 to 20.',
  evidence: [{ path: 'code.js', line: 1, quote: 'const timeout = 20;' }],
  changes: [{ path: 'README.md', before: '10 seconds', after: '20 seconds' }] };
function response(value, finish_reason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] }));
}

test('AI context reuses drift relationships and sends only allowed committed text and relevant diffs', t => {
  const { root, git } = fixture(t);
  fs.writeFileSync(path.join(root, 'code.js'), 'UNCOMMITTED SECRET\n');
  fs.symlinkSync('/etc/passwd', path.join(root, 'link.js'));
  git('add', 'link.js'); git('commit', '-qm', 'symlink');
  const context = buildContext(check(root), ['README.md', '*.js']);
  assert.deepEqual(context.files.map(f => f.path), ['README.md', 'code.js']);
  assert.equal(context.files[1].content, 'const timeout = 20;\n');
  assert.match(context.diffs[0].diff, /\+const timeout = 20;/);
  assert.doesNotMatch(JSON.stringify(context), /UNCOMMITTED|do not send this|root:x:/);
  assert.equal(context.documents[0], 'README.md');
  assert.throws(() => buildContext(check(root), []), /allowlist/);
});

test('analysis never runs configured external diff or text conversion commands', t => {
  const { root, git } = fixture(t);
  const marker = path.join(root, 'executed');
  git('config', 'diff.external', `touch ${marker}`);
  git('config', 'diff.evil.textconv', `touch ${marker}`);
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.js diff=evil\n');
  git('add', '.gitattributes'); git('commit', '-qm', 'attributes');
  buildContext(check(root), ['README.md', 'code.js']);
  assert.equal(fs.existsSync(marker), false);
});

test('validated edits generate a patch that applies, without changing source files', t => {
  const { root, git } = fixture(t);
  const context = buildContext(check(root), ['README.md', 'code.js']);
  const result = validateReview(mismatch, context);
  const patchPath = path.join(root, 'candidate.patch'); fs.writeFileSync(patchPath, result.patch);
  git('apply', '--check', patchPath);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'Timeout is 10 seconds.\n');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  git('apply', patchPath);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'Timeout is 20 seconds.\n');
});

test('proposed replacement text preserves literal JavaScript replacement tokens', t => {
  const { root, git } = fixture(t);
  const context = buildContext(check(root), ['README.md', 'code.js']);
  const after = "$& $$ $` $'";
  const result = validateReview({ ...mismatch, changes: [{ path: 'README.md', before: '10 seconds', after }] }, context);
  const patchPath = path.join(root, 'literal.patch'); fs.writeFileSync(patchPath, result.patch);
  git('apply', patchPath);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), `Timeout is ${after}.\n`);
});

test('rejects hallucinated evidence, code edits, repeated edits, and inconsistent statuses', t => {
  const { root } = fixture(t); const context = buildContext(check(root), ['README.md', 'code.js']);
  for (const bad of [
    { ...mismatch, evidence: [{ path: 'code.js', line: 1, quote: 'timeout = 99' }] },
    { ...mismatch, changes: [{ path: '../outside.md', before: '10', after: '20' }] },
    { ...mismatch, changes: [{ path: 'code.js', before: '20', after: '99' }] },
    { ...mismatch, changes: [...mismatch.changes, ...mismatch.changes] },
    { ...mismatch, status: 'no_change' }, { ...mismatch, evidence: [] }
  ]) assert.throws(() => validateReview(bad, context));
});

test('mock provider contract, no-change, insufficient evidence, refusals, invalid JSON and HTTP errors', async t => {
  const { root } = fixture(t); const context = buildContext(check(root), ['README.md', 'code.js']);
  const options = { key: 'fixture-secret', model: 'fixture-model', maxTokens: 1000, timeoutMs: 1000 };
  let calls = 0;
  const mock = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.max_completion_tokens, 1000);
    assert.equal(body.model, 'fixture-model'); assert.equal(init.redirect, 'error');
    assert.doesNotMatch(init.body, /fixture-secret/);
    assert.match(body.messages[0].content, /untrusted data/);
    return response(mismatch);
  };
  assert.equal((await requestReview(context, { ...options, fetch: mock })).status, 'mismatch');
  assert.equal(calls, 1);
  for (const status of ['no_change', 'insufficient_evidence']) {
    assert.equal((await requestReview(context, { ...options, fetch: async () => response({ status, explanation: 'Fixture result.', evidence: [], changes: [] }) })).status, status);
  }
  for (const mockResponse of [new Response('private provider error', { status: 429 }), new Response('bad JSON'), response(mismatch, 'length'), new Response('x'.repeat(LIMITS.responseBytes + 1))]) {
    await assert.rejects(requestReview(context, { ...options, fetch: async () => mockResponse }));
  }
  await assert.rejects(requestReview(context, { ...options, fetch: async () => { throw new Error('timeout'); } }));
  const empty = await requestReview({ ...context, documents: [] }, { ...options, fetch: () => { throw new Error('must not call'); } });
  assert.equal(empty.status, 'insufficient_evidence');
});

test('deadline expires while reading a stalled provider response', async t => {
  const { root } = fixture(t); const context = buildContext(check(root), ['README.md', 'code.js']);
  let bodyAborted = false;
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(requestReview(context, { key: 'fixture', model: 'fixture', maxTokens: 256, timeoutMs: 10,
      fetch: async (_url, init) => new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => { bodyAborted = true; controller.error(init.signal.reason); });
      } })) }));
    assert.equal(bodyAborted, true);
  } finally { clearTimeout(keepAlive); }
});

test('deleted related code is explicitly recorded as an evidence gap', t => {
  const { root, git } = fixture(t);
  git('rm', 'code.js'); git('commit', '-qm', 'remove API');
  const context = buildContext(check(root), ['README.md', 'code.js']);
  assert.ok(context.coverage.omitted.some(p => p.startsWith('code.js (deleted;')));
  assert.ok(context.coverage.excludedByAllowlist > 0);
});

test('file and context limits exclude oversized files', t => {
  const { root, git } = fixture(t);
  fs.writeFileSync(path.join(root, 'huge.js'), 'x'.repeat(LIMITS.fileBytes + 1));
  git('add', '.'); git('commit', '-qm', 'large');
  const context = buildContext(check(root), ['README.md', '*.js']);
  assert.ok(context.coverage.omitted.includes('huge.js'));
  assert.ok(!context.files.some(f => f.path === 'huge.js'));
});

test('event policy skips forks and rejects pull_request_target and unsupported events', t => {
  const { root } = fixture(t); const eventPath = path.join(root, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { repo: { full_name: 'fork/project' } } } }));
  const env = { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'owner/project' };
  assert.equal(eventPolicy(env).fork, true);
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { repo: { full_name: 'owner/project' } } } }));
  assert.equal(eventPolicy(env).fork, false);
  assert.throws(() => eventPolicy({ ...env, GITHUB_EVENT_NAME: 'pull_request_target' }));
  assert.throws(() => eventPolicy({ ...env, GITHUB_EVENT_NAME: 'issue_comment' }));
});

test('bundled Action consumer works without node_modules, writes artifacts and summary, respects drift gate and fork key policy', t => {
  const { root } = fixture(t);
  const eventPath = path.join(root, 'event.json'); fs.writeFileSync(eventPath, '{}');
  const output = path.join(root, 'outputs'); const summary = path.join(root, 'summary');
  fs.writeFileSync(output, ''); fs.writeFileSync(summary, '');
  const installed = path.join(root, 'installed-action');
  fs.cpSync(path.join(__dirname, '../dist'), installed, { recursive: true });
  const consumer = path.join(installed, 'index.js');
  const env = { ...process.env, GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'push',
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root,
    'INPUT_AI-REVIEW': 'false', 'INPUT_FAIL-ON-DRIFT': 'false', 'INPUT_OPENAI-API-KEY': '' };
  let result = spawnSync(process.execPath, [consumer], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(output, 'utf8'), /drift-detected<<.*\ntrue\n/);
  const artifacts = fs.readdirSync(root).find(p => p.startsWith('catchmydrift-'));
  const report = JSON.parse(fs.readFileSync(path.join(root, artifacts, 'report.json')));
  assert.equal(report.ai.status, 'disabled'); assert.equal(report.driftDetected, true);
  assert.match(fs.readFileSync(summary, 'utf8'), /Catch My Drift/);
  result = spawnSync(process.execPath, [consumer], { cwd: root, env: { ...env, 'INPUT_FAIL-ON-DRIFT': 'true' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  result = spawnSync(process.execPath, [consumer], { cwd: root, env: { ...env, GITHUB_EVENT_NAME: 'pull_request', 'INPUT_AI-REVIEW': 'true' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(output, 'utf8'), /skipped_fork/);
});
