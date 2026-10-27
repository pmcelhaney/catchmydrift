const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cliEntryPoint = path.resolve(__dirname, '..', 'index.js');
const stateFileName = '.catchmydrift-state.json';

function runGit(directory, args, options = {}) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', ...options });
}

function writeFile(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function readFile(repository, relativePath) {
  return fs.readFileSync(path.join(repository, relativePath), 'utf8');
}

function createRepository(t, files = {}) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-review-test-'));
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'catchmydrift review test']);
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(repository, relativePath, contents);
  }
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '--quiet', '-m', 'initial fixture']);
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return repository;
}

function commitAll(repository, message) {
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '--quiet', '-m', message]);
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliEntryPoint, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CATCHMYDRIFT_NO_UPDATE_CHECK: '1' } });
}

function assertStatus(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

function review(repository, targets, options = {}) {
  const root = options.root || repository;
  const args = ['review', ...targets, '--root', root];
  if (options.config) {
    args.push('--config', options.config);
  }
  return runCli(args, options.cwd || repository);
}

function check(repository, options = {}) {
  const args = ['check', options.root || repository];
  if (options.threshold !== undefined) {
    args.push('--threshold', String(options.threshold));
  }
  if (options.config) {
    args.push('--config', options.config);
  }
  return runCli(args, options.cwd || repository);
}

function statePath(root) {
  return path.join(root, stateFileName);
}

function readState(root) {
  return JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
}

function assertStateShape(state, expectedWatchedPaths) {
  assert.deepEqual(Object.keys(state), [...expectedWatchedPaths].sort());
  for (const watchedPath of expectedWatchedPaths) {
    assert.match(state[watchedPath], /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  }
}

function defaultFixture(t) {
  return createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'before\n'
  });
}

function configuredFixture(t) {
  const config = {
    groups: { source: { include: ['source/**'] } },
    watch: [{ include: ['instructions/manual.txt'], groups: ['source'] }]
  };
  return createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config, null, 2)}\n`,
    'instructions/manual.txt': 'Use the service safely.\n',
    'source/service.txt': 'before\n',
    'source/unchanged.txt': 'unchanged\n'
  });
}

test('review accepts zero-config Markdown and configured arbitrary watched files', t => {
  const zeroConfigRepository = defaultFixture(t);
  writeFile(zeroConfigRepository, 'docs/service.txt', 'after\n');
  commitAll(zeroConfigRepository, 'commit related changes');

  assertStatus(review(zeroConfigRepository, ['docs/README.md']), 0);
  assertStateShape(readState(zeroConfigRepository), ['docs/README.md']);
  assertStatus(check(zeroConfigRepository), 0);

  const configuredRepository = configuredFixture(t);
  writeFile(configuredRepository, 'source/service.txt', 'after\n');
  commitAll(configuredRepository, 'commit related changes');

  assertStatus(review(configuredRepository, ['instructions/manual.txt']), 0);
  assertStateShape(readState(configuredRepository), ['instructions/manual.txt']);
  assertStatus(check(configuredRepository), 0);
});

test('review accepts root and configuration options before or after targets, with -- protecting a filename', t => {
  const repository = createRepository(t, {
    '-manual.md': '# Manual\n',
    'service.txt': 'before\n'
  });
  writeFile(repository, 'service.txt', 'after\n');
  commitAll(repository, 'commit related changes');

  assertStatus(runCli(['review', '--root', repository, '--', '-manual.md'], repository), 0);
  assertStateShape(readState(repository), ['-manual.md']);

  const config = {
    groups: { source: { include: ['service.txt'] } },
    watch: [{ include: ['-manual.md'], groups: ['source'] }]
  };
  writeFile(repository, 'catchmydrift.config.json', `${JSON.stringify(config)}\n`);
  assertStatus(runCli(['review', '--config', 'catchmydrift.config.json', '--root', repository, '--', '-manual.md'], repository), 0);
});

test('configured reserved watched names, including __proto__, persist as safe own review entries', t => {
  const config = {
    groups: { source: { include: ['source/**'] } },
    watch: [
      { include: ['__proto__'], groups: ['source'] },
      { include: ['constructor'], groups: ['source'] },
      { include: ['prototype'], groups: ['source'] }
    ]
  };
  const files = Object.create(null);
  files['catchmydrift.config.json'] = `${JSON.stringify(config, null, 2)}\n`;
  files.__proto__ = 'Prototype safety manual\n';
  files.constructor = 'Constructor safety manual\n';
  files.prototype = 'Prototype safety appendix\n';
  files['source/service.txt'] = 'before\n';
  const repository = createRepository(t, files);
  writeFile(repository, 'source/service.txt', 'reviewed\n');
  commitAll(repository, 'commit related changes');

  assertStatus(review(repository, ['__proto__', 'constructor', 'prototype']), 0);
  const state = readState(repository);
  assert.deepEqual(Object.keys(state), ['__proto__', 'constructor', 'prototype']);
  for (const watchedPath of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(Object.hasOwn(state, watchedPath), true);
  }
  assert.equal(Object.getPrototypeOf(state), Object.prototype);
  assertStatus(check(repository), 0);
});

test('review records HEAD without changing watched bytes, mtime, or the index', t => {
  const repository = defaultFixture(t);
  const watchedPath = path.join(repository, 'docs/README.md');
  const watchedBytes = fs.readFileSync(watchedPath);
  const watchedMtime = fs.statSync(watchedPath).mtimeMs;
  const before = runGit(repository, ['status', '--porcelain=v1']);
  assertStatus(review(repository, ['docs/README.md']), 0);
  assert.equal(readState(repository)['docs/README.md'], runGit(repository, ['rev-parse', 'HEAD']).trim());
  assert.deepEqual(fs.readFileSync(watchedPath), watchedBytes);
  assert.equal(fs.statSync(watchedPath).mtimeMs, watchedMtime);
  assert.equal(runGit(repository, ['diff', '--cached', '--name-only']), '');
  const after = runGit(repository, ['status', '--porcelain=v1']);
  assert.equal(after.replace(/^\?\? \.catchmydrift-state\.json\n?/m, ''), before);
});

test('batch review state is deterministic and a rerun changes only its requested entry', t => {
  const repository = createRepository(t, {
    'a/README.md': '# A\n',
    'a/service.txt': 'one\n',
    'z/README.md': '# Z\n',
    'z/service.txt': 'one\n'
  });
  writeFile(repository, 'a/service.txt', 'two\n');
  commitAll(repository, 'commit related changes');
  writeFile(repository, 'z/service.txt', 'two\n');
  commitAll(repository, 'commit related changes');

  assertStatus(review(repository, ['z/README.md', 'a/README.md']), 0);
  const firstState = readState(repository);
  assertStateShape(firstState, ['a/README.md', 'z/README.md']);
  const beforeUntargetedEntry = structuredClone(firstState['z/README.md']);
  const beforeTargetedEntry = structuredClone(firstState['a/README.md']);

  writeFile(repository, 'a/service.txt', 'three\n');
  commitAll(repository, 'commit related changes');
  assertStatus(review(repository, ['a/README.md']), 0);
  const secondState = readState(repository);

  assert.deepEqual(secondState['z/README.md'], beforeUntargetedEntry);
  assert.notDeepEqual(secondState['a/README.md'], beforeTargetedEntry);
  assertStateShape(secondState, ['a/README.md', 'z/README.md']);
});

test('post-review edits use normal percentage drift and cannot be reviewed until committed', t => {
  const repository = defaultFixture(t);
  assertStatus(review(repository, ['docs/README.md']), 0);
  const before = readFile(repository, stateFileName);
  writeFile(repository, 'docs/service.txt', 'changed after review\n');
  assertStatus(check(repository, { threshold: 100 }), 0);
  assertStatus(check(repository, { threshold: 0 }), 1);
  assertStatus(review(repository, ['docs/README.md']), 2);
  assert.equal(readFile(repository, stateFileName), before);
  commitAll(repository, 'commit source');
  assertStatus(review(repository, ['docs/README.md']), 0);
  assertStatus(check(repository, { threshold: 0 }), 0);
});

test('a review committed with its reviewed changes remains valid in the same repository and a fresh clone', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed change\n');
  commitAll(repository, 'commit related changes');
  assertStatus(review(repository, ['docs/README.md']), 0);
  commitAll(repository, 'review documentation drift');

  assertStatus(check(repository), 0);

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-review-clone-'));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  runGit(os.tmpdir(), ['clone', '--quiet', repository, clone]);
  assertStatus(check(clone), 0);
});

test('rerunning review at the same HEAD produces identical state', t => {
  const repository = defaultFixture(t);
  assertStatus(review(repository, ['docs/README.md']), 0);
  const before = readFile(repository, stateFileName);
  assertStatus(review(repository, ['docs/README.md']), 0);
  assert.equal(readFile(repository, stateFileName), before);
});

test('dirty selected content rejects the entire batch without modifying state or the index', t => {
  for (const mode of ['unstaged', 'staged', 'staged-then-restored', 'addition', 'deletion', 'watched']) {
    const repository = createRepository(t, { 'a/README.md': '# A\n', 'z/README.md': '# Z\n', 'z/source.txt': 'before\n' });
    assertStatus(review(repository, ['a/README.md']), 0);
    const before = readFile(repository, stateFileName);
    const target = mode === 'watched' ? 'z/README.md' : mode === 'addition' ? 'z/new.txt' : 'z/source.txt';
    if (mode === 'deletion') runGit(repository, ['rm', target]);
    else writeFile(repository, target, 'after\n');
    if (['staged', 'staged-then-restored', 'addition'].includes(mode)) runGit(repository, ['add', target]);
    if (mode === 'staged-then-restored') writeFile(repository, target, 'before\n');
    const status = runGit(repository, ['status', '--porcelain=v1']);
    assertStatus(review(repository, ['a/README.md', 'z/README.md']), 2);
    assert.equal(readFile(repository, stateFileName), before);
    assert.equal(runGit(repository, ['status', '--porcelain=v1']), status);
  }
});

test('unrelated dirty tracked files and untracked related files do not block review', t => {
  const repository = createRepository(t, { 'docs/README.md': '# Docs\n', 'elsewhere/source.txt': 'before\n' });
  writeFile(repository, 'elsewhere/source.txt', 'after\n');
  writeFile(repository, 'docs/untracked.txt', 'untracked\n');
  assertStatus(review(repository, ['docs/README.md']), 0);
});

test('subsequent related changes resume percent drift while state edits do not contribute', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed\n');
  commitAll(repository, 'commit related changes');
  assertStatus(review(repository, ['docs/README.md']), 0);
  commitAll(repository, 'commit reviewed source and marker');
  writeFile(repository, 'docs/service.txt', 'changed again\n');

  const beforeStateEdit = check(repository);
  assertStatus(beforeStateEdit, 1);
  assert.match(beforeStateEdit.stdout, /100\.00%.*README\.md/);

  const state = readState(repository);
  fs.writeFileSync(statePath(repository), `${JSON.stringify(state, null, 2)}\n`);
  const afterStateEdit = check(repository);
  assertStatus(afterStateEdit, 1);
  assert.match(afterStateEdit.stdout, /100\.00%.*README\.md/);
});

test('a later watched-file commit supersedes an older review', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed\n');
  commitAll(repository, 'commit related changes');
  assertStatus(review(repository, ['docs/README.md']), 0);
  commitAll(repository, 'commit reviewed source and marker');

  writeFile(repository, 'docs/service.txt', 'change acknowledged by document update\n');
  commitAll(repository, 'commit source change before document update');
  assertStatus(check(repository, { threshold: 0 }), 1);
  writeFile(repository, 'docs/README.md', '# Updated docs\n');
  runGit(repository, ['add', 'docs/README.md']);
  runGit(repository, ['commit', '--quiet', '-m', 'update watched document']);
  assertStatus(check(repository, { threshold: 0 }), 0);
  writeFile(repository, 'docs/service.txt', 'changed after watched document\n');

  const result = check(repository);
  assertStatus(result, 1);
  assert.match(result.stdout, /100\.00%.*README\.md/);
});

test('a committed deletion of a related file resumes drift at threshold zero for default and configured relationships', t => {
  const cases = [
    {
      name: 'default',
      create: () => defaultFixture(t),
      watchedPath: 'docs/README.md',
      relatedPath: 'docs/service.txt'
    },
    {
      name: 'configured',
      create: () => configuredFixture(t),
      watchedPath: 'instructions/manual.txt',
      relatedPath: 'source/service.txt'
    }
  ];

  for (const fixture of cases) {
    const repository = fixture.create();
    assertStatus(review(repository, [fixture.watchedPath]), 0);
    commitAll(repository, `commit ${fixture.name} review`);
    runGit(repository, ['rm', '--quiet', fixture.relatedPath]);
    runGit(repository, ['commit', '--quiet', '-m', `delete ${fixture.name} related file`]);

    const result = check(repository, { threshold: 0 });
    assertStatus(result, 1);
    assert.match(result.stdout, new RegExp(fixture.watchedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('current configured relationships use the saved SHA without relationship signatures', t => {
  const repository = configuredFixture(t);
  assertStatus(review(repository, ['instructions/manual.txt']), 0);
  const config = { groups: { source: { include: ['source/unchanged.txt'] } }, watch: [{ include: ['instructions/manual.txt'], groups: ['source'] }] };
  writeFile(repository, 'catchmydrift.config.json', JSON.stringify(config));
  writeFile(repository, 'source/service.txt', 'excluded change\n');
  assertStatus(check(repository), 0);
  writeFile(repository, 'source/unchanged.txt', 'included change\n');
  const result = check(repository);
  assertStatus(result, 1);
  assert.match(result.stdout, /200\.00%.*manual\.txt/);
  assert.doesNotMatch(result.stdout, /warning|relationship/i);
});

test('malformed, unsupported, and invalid review state is unhealthy', t => {
  const repository = defaultFixture(t);
  const invalidStates = [
    '{ not JSON',
    { version: 2, reviews: {} },
    { version: 1, reviews: [] },
    { version: 1, reviews: { 'docs/README.md': null } },
    {
      version: 1,
      reviews: {
        'docs/README.md': {
          token: 'not-a-valid-token',
          relationship: 'not-a-valid-relationship',
          snapshotDigest: 'not-a-valid-snapshot',
          files: []
        }
      }
    }
  ];

  for (const state of invalidStates) {
    fs.writeFileSync(statePath(repository), typeof state === 'string' ? state : `${JSON.stringify(state)}\n`);
    const result = check(repository);
    assertStatus(result, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /state|review|health|invalid/i);
  }
});

test('review refuses malformed or unsupported state without overwriting it', t => {
  const repository = defaultFixture(t);
  const invalidStates = [
    '{ not JSON',
    `${JSON.stringify({ version: 2, reviews: {} })}\n`
  ];

  for (const contents of invalidStates) {
    fs.writeFileSync(statePath(repository), contents);
    const result = review(repository, ['docs/README.md']);
    assertStatus(result, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /state|review|health|invalid/i);
    assert.equal(fs.readFileSync(statePath(repository), 'utf8'), contents);
  }
});

test('review rejects invalid targets and review threshold without writing a partial state file', t => {
  const repository = defaultFixture(t);
  const invalidCalls = [
    ['review', 'docs/missing.md', '--root', repository],
    ['review', 'docs/service.txt', '--root', repository],
    ['review', '../outside.md', '--root', path.join(repository, 'docs')],
    ['review', 'docs/README.md', '--root', repository, '--threshold', '0']
  ];

  for (const args of invalidCalls) {
    fs.rmSync(statePath(repository), { force: true });
    assertStatus(runCli(args, repository), 2);
    assert.equal(fs.existsSync(statePath(repository)), false);
  }

  assertStatus(review(repository, ['docs/README.md', 'docs/service.txt']), 2);
  assert.equal(fs.existsSync(statePath(repository)), false);
});

test('review rejects a watched target made unsafe by an intermediate working-tree symlink', t => {
  const repository = createRepository(t, {
    'unsafe/README.md': '# Unsafe\n',
    'unsafe/service.txt': 'service\n',
    'elsewhere/README.md': '# Elsewhere\n'
  });
  fs.rmSync(path.join(repository, 'unsafe'), { recursive: true, force: true });
  try {
    fs.symlinkSync('elsewhere', path.join(repository, 'unsafe'));
  } catch (error) {
    t.skip(`symlinks are unavailable in this environment: ${error.message}`);
    return;
  }

  assertStatus(review(repository, ['unsafe/README.md']), 2);
  assert.equal(fs.existsSync(statePath(repository)), false);
});

test('default and configured review state files are written under the selected root, including a repository subdirectory', t => {
  const repository = createRepository(t, {
    'scope/README.md': '# Scope\n',
    'scope/service.txt': 'before\n',
    'configured/catchmydrift.config.json': `${JSON.stringify({
      groups: { source: { include: ['source/**'] } },
      watch: [{ include: ['manual.txt'], groups: ['source'] }]
    }, null, 2)}\n`,
    'configured/manual.txt': 'Manual\n',
    'configured/source/service.txt': 'before\n'
  });
  writeFile(repository, 'scope/service.txt', 'after\n');
  commitAll(repository, 'commit related changes');
  assertStatus(review(repository, ['README.md'], { root: path.join(repository, 'scope') }), 0);
  assert.equal(fs.existsSync(statePath(path.join(repository, 'scope'))), true);
  assert.equal(fs.existsSync(statePath(repository)), false);

  writeFile(repository, 'configured/source/service.txt', 'after\n');
  commitAll(repository, 'commit related changes');
  assertStatus(review(repository, ['manual.txt'], { root: path.join(repository, 'configured') }), 0);
  assert.equal(fs.existsSync(statePath(path.join(repository, 'configured'))), true);
  assert.equal(fs.existsSync(statePath(repository)), false);

  writeFile(repository, 'scope/service.txt', 'again\n');
  commitAll(repository, 'commit related changes');
  assertStatus(runCli(['review', 'README.md', '--root', '.'], path.join(repository, 'scope')), 0);
  assert.equal(fs.existsSync(statePath(path.join(repository, 'scope'))), true);
});

test('review requires committed binary and symlink content even though binary drift is ignored', t => {
  const repository = createRepository(t, { 'docs/README.md': '# Docs\n', 'docs/picture.bin': Buffer.from([0, 1]) });
  writeFile(repository, 'docs/picture.bin', Buffer.from([0, 2]));
  assertStatus(review(repository, ['docs/README.md']), 2);
  commitAll(repository, 'commit binary');
  fs.symlinkSync('picture.bin', path.join(repository, 'docs/link'));
  runGit(repository, ['add', 'docs/link']);
  assertStatus(review(repository, ['docs/README.md']), 2);
  commitAll(repository, 'commit link');
  assertStatus(review(repository, ['docs/README.md']), 0);
  fs.unlinkSync(path.join(repository, 'docs/link'));
  fs.symlinkSync('elsewhere.bin', path.join(repository, 'docs/link'));
  assertStatus(review(repository, ['docs/README.md']), 2);
});

test('help documents the review command', () => {
  const result = runCli(['--help'], os.tmpdir());
  assertStatus(result, 0);
  assert.match(result.stdout, /\breview\b/i);
});

test('state schema and runtime agree on path and SHA shapes', t => {
  const Ajv = require('ajv/dist/2020');
  const validate = new Ajv().compile(require('../catchmydrift-state.schema.json'));
  const repository = defaultFixture(t);
  const commit = runGit(repository, ['rev-parse', 'HEAD']).trim();
  const scan = { repositoryRoot: repository, rootRelative: '.' };
  const { validateState } = require('../lib/review-state');
  const valid = [{}, { 'docs/README.md': commit }, JSON.parse(`{"__proto__":"${commit}"}`)];
  for (const state of valid) {
    assert.equal(validate(state), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => validateState(state, scan));
  }
  const invalid = [null, [], { version: 1, reviews: {} }, { 'docs/README.md': 'HEAD' },
    { 'docs/README.md': commit.slice(0, 7) }, { 'docs/README.md': commit + '\n' }, { 'docs/README.md': null }];
  for (const name of ['', '.', '..', '../escape.md', '/absolute.md', 'docs/../README.md',
    'docs//README.md', 'docs/./README.md', 'docs/', 'docs/README.md\0', '.catchmydrift-state.json',
    'docs/.catchmydrift-state.json']) invalid.push({ [name]: commit });
  for (const state of invalid) {
    assert.equal(validate(state), false, JSON.stringify(state));
    assert.throws(() => validateState(state, scan), /state|path|SHA|object/i);
  }
  assert.equal(validate({ 'docs/README.md': 'a'.repeat(64) }), true);
  assert.throws(() => validateState({ 'outside.md': commit }, { ...scan, rootRelative: 'docs' }), /path/i);
});

test('missing, non-commit, and unreachable SHAs fail checks and cannot be overwritten by review', t => {
  const repository = defaultFixture(t);
  const originalHead = runGit(repository, ['rev-parse', 'HEAD']).trim();
  const blob = runGit(repository, ['rev-parse', 'HEAD:docs/README.md']).trim();
  runGit(repository, ['checkout', '--quiet', '-b', 'other']);
  writeFile(repository, 'docs/service.txt', 'other branch\n');
  commitAll(repository, 'other branch');
  const unreachable = runGit(repository, ['rev-parse', 'HEAD']).trim();
  runGit(repository, ['checkout', '--quiet', '--detach', originalHead]);
  for (const sha of ['a'.repeat(40), blob, unreachable]) {
    const contents = JSON.stringify({ 'docs/README.md': sha }) + '\n';
    writeFile(repository, stateFileName, contents);
    assertStatus(check(repository), 1);
    assertStatus(review(repository, ['docs/README.md']), 1);
    assert.equal(readFile(repository, stateFileName), contents);
  }
});

test('review in an unborn repository rejects staged files without creating state', t => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-unborn-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  runGit(repository, ['init', '--quiet']);
  writeFile(repository, 'README.md', '# Initial\n');
  runGit(repository, ['add', 'README.md']);
  const result = review(repository, ['README.md']);
  assertStatus(result, 2);
  assert.match(result.stderr, /committed HEAD/);
  assert.equal(fs.existsSync(statePath(repository)), false);
});
