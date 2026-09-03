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
  return spawnSync(process.execPath, [cliEntryPoint, ...args], { cwd, encoding: 'utf8' });
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
  assert.deepEqual(Object.keys(state), ['version', 'reviews']);
  assert.equal(state.version, 1);
  assert.deepEqual(Object.keys(state.reviews), [...expectedWatchedPaths].sort());

  for (const watchedPath of expectedWatchedPaths) {
    const entry = state.reviews[watchedPath];
    assert.deepEqual(Object.keys(entry), ['token', 'relationship', 'snapshotDigest', 'files']);
    assert.equal(typeof entry.token, 'string');
    assert.ok(entry.token.length > 0);
    assert.equal(typeof entry.relationship, 'string');
    assert.ok(entry.relationship.length > 0);
    assert.equal(typeof entry.snapshotDigest, 'string');
    assert.ok(entry.snapshotDigest.length > 0);
    assert.ok(Array.isArray(entry.files));
    assert.deepEqual(entry.files.map(file => file.path), [...entry.files.map(file => file.path)].sort());
    for (const file of entry.files) {
      assert.deepEqual(Object.keys(file), ['path', 'blob']);
      assert.equal(typeof file.path, 'string');
      assert.ok(file.path.length > 0);
      assert.ok(file.blob === null || (typeof file.blob === 'string' && file.blob.length > 0));
    }
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

  assertStatus(review(zeroConfigRepository, ['docs/README.md']), 0);
  assertStateShape(readState(zeroConfigRepository), ['docs/README.md']);
  assertStatus(check(zeroConfigRepository), 0);

  const configuredRepository = configuredFixture(t);
  writeFile(configuredRepository, 'source/service.txt', 'after\n');

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

  assertStatus(review(repository, ['__proto__', 'constructor', 'prototype']), 0);
  const state = readState(repository);
  assert.deepEqual(Object.keys(state.reviews), ['__proto__', 'constructor', 'prototype']);
  for (const watchedPath of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(Object.hasOwn(state.reviews, watchedPath), true);
  }
  assert.equal(Object.getPrototypeOf(state.reviews), Object.prototype);
  assertStatus(check(repository), 0);
});

test('review binds dirty related worktree content without changing watched bytes or mtime', t => {
  const repository = defaultFixture(t);
  const watchedPath = path.join(repository, 'docs/README.md');
  const watchedBytes = fs.readFileSync(watchedPath);
  const watchedMtime = fs.statSync(watchedPath).mtimeMs;
  writeFile(repository, 'docs/service.txt', 'dirty but reviewed\n');
  const before = runGit(repository, ['status', '--porcelain=v1']);

  assertStatus(review(repository, ['docs/README.md']), 0);

  assert.deepEqual(fs.readFileSync(watchedPath), watchedBytes);
  assert.equal(fs.statSync(watchedPath).mtimeMs, watchedMtime);
  assert.equal(runGit(repository, ['diff', '--cached', '--name-only']), '');
  const after = runGit(repository, ['status', '--porcelain=v1']);
  assert.match(after, /^ M docs\/service\.txt$/m);
  assert.match(after, /^\?\? \.catchmydrift-state\.json$/m);
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
  writeFile(repository, 'z/service.txt', 'two\n');

  assertStatus(review(repository, ['z/README.md', 'a/README.md']), 0);
  const firstState = readState(repository);
  assertStateShape(firstState, ['a/README.md', 'z/README.md']);
  const beforeUntargetedEntry = structuredClone(firstState.reviews['z/README.md']);
  const beforeTargetedEntry = structuredClone(firstState.reviews['a/README.md']);

  writeFile(repository, 'a/service.txt', 'three\n');
  assertStatus(review(repository, ['a/README.md']), 0);
  const secondState = readState(repository);

  assert.deepEqual(secondState.reviews['z/README.md'], beforeUntargetedEntry);
  assert.notDeepEqual(secondState.reviews['a/README.md'], beforeTargetedEntry);
  assertStateShape(secondState, ['a/README.md', 'z/README.md']);
});

test('a post-review related edit makes approval stale regardless of threshold, and rerunning review restores it', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed\n');
  assertStatus(review(repository, ['docs/README.md']), 0);

  writeFile(repository, 'docs/service.txt', 'changed after review\n');
  const stale = check(repository, { threshold: 100 });
  assertStatus(stale, 1);
  assert.match(`${stale.stdout}\n${stale.stderr}`, /stale|review|approval/i);
  assert.match(stale.stdout, /failed|approval/i);
  assert.doesNotMatch(stale.stdout, /exceeds the .*threshold|missing or exceeds/i);

  assertStatus(review(repository, ['docs/README.md']), 0);
  assertStatus(check(repository, { threshold: 100 }), 0);
});

test('a review committed with its reviewed changes remains valid in the same repository and a fresh clone', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed change\n');
  assertStatus(review(repository, ['docs/README.md']), 0);
  commitAll(repository, 'review documentation drift');

  assertStatus(check(repository), 0);

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-review-clone-'));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  runGit(os.tmpdir(), ['clone', '--quiet', repository, clone]);
  assertStatus(check(clone), 0);
});

test('a logically identical committed review remains valid when entry and file-record JSON keys are reordered', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed change\n');
  assertStatus(review(repository, ['docs/README.md']), 0);
  commitAll(repository, 'commit reviewed source and marker');

  const state = readState(repository);
  const entry = state.reviews['docs/README.md'];
  const reordered = {
    version: state.version,
    reviews: {
      'docs/README.md': {
        files: entry.files.map(file => ({ blob: file.blob, path: file.path })),
        snapshotDigest: entry.snapshotDigest,
        relationship: entry.relationship,
        token: entry.token
      }
    }
  };
  fs.writeFileSync(statePath(repository), `${JSON.stringify(reordered, null, 2)}\n`);
  commitAll(repository, 'reorder review JSON keys without changing review values');

  assertStatus(check(repository), 0);
});

test('a committed state without the exact reviewed related content is an invalid snapshot', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed content\n');
  assertStatus(review(repository, ['docs/README.md']), 0);

  writeFile(repository, 'docs/service.txt', 'before\n');
  commitAll(repository, 'commit marker without its reviewed source');
  const result = check(repository);

  assertStatus(result, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /invalid|snapshot|review/i);
  assert.match(result.stdout, /failed|approval/i);
  assert.doesNotMatch(result.stdout, /exceeds the .*threshold|missing or exceeds/i);
});

test('subsequent related changes resume percent drift while state edits do not contribute', t => {
  const repository = defaultFixture(t);
  writeFile(repository, 'docs/service.txt', 'reviewed\n');
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
  assertStatus(review(repository, ['docs/README.md']), 0);
  commitAll(repository, 'commit reviewed source and marker');

  writeFile(repository, 'docs/README.md', '# Updated docs\n');
  runGit(repository, ['add', 'docs/README.md']);
  runGit(repository, ['commit', '--quiet', '-m', 'update watched document']);
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

test('a changed configured relationship warns, ignores its old marker, and falls back to the watched baseline', t => {
  const originalConfig = {
    groups: { source: { include: ['source/a.txt'] } },
    watch: [{ include: ['instructions/manual.txt'], groups: ['source'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(originalConfig, null, 2)}\n`,
    'instructions/manual.txt': 'Manual\n',
    'source/a.txt': 'before\n',
    'source/b.txt': 'before\n'
  });
  writeFile(repository, 'source/a.txt', 'reviewed\n');
  assertStatus(review(repository, ['instructions/manual.txt']), 0);

  const changedConfig = {
    groups: { source: { include: ['source/b.txt'] } },
    watch: [{ include: ['instructions/manual.txt'], groups: ['source'] }]
  };
  writeFile(repository, 'catchmydrift.config.json', `${JSON.stringify(changedConfig, null, 2)}\n`);
  writeFile(repository, 'source/b.txt', 'changed\n');
  const result = check(repository);

  assertStatus(result, 1);
  assert.match(result.stdout, /200\.00%.*manual\.txt/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /relationship|configuration|review|marker/i);
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
  assertStatus(review(repository, ['README.md'], { root: path.join(repository, 'scope') }), 0);
  assert.equal(fs.existsSync(statePath(path.join(repository, 'scope'))), true);
  assert.equal(fs.existsSync(statePath(repository)), false);

  writeFile(repository, 'configured/source/service.txt', 'after\n');
  assertStatus(review(repository, ['manual.txt'], { root: path.join(repository, 'configured') }), 0);
  assert.equal(fs.existsSync(statePath(path.join(repository, 'configured'))), true);
  assert.equal(fs.existsSync(statePath(repository)), false);

  writeFile(repository, 'scope/service.txt', 'again\n');
  assertStatus(runCli(['review', 'README.md', '--root', '.'], path.join(repository, 'scope')), 0);
  assert.equal(fs.existsSync(statePath(path.join(repository, 'scope'))), true);
});

test('review snapshots binary files and final symlink link text without dereferencing the link', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/target.txt': 'target contents\n',
    'docs/picture.bin': Buffer.from([0, 1, 2, 255])
  });
  const linkPath = path.join(repository, 'docs', 'link-to-target');
  try {
    fs.symlinkSync('target.txt', linkPath);
  } catch (error) {
    t.skip(`symlinks are unavailable in this environment: ${error.message}`);
    return;
  }
  runGit(repository, ['add', 'docs/link-to-target']);
  runGit(repository, ['commit', '--quiet', '-m', 'add symlink fixture']);

  assertStatus(review(repository, ['docs/README.md']), 0);
  const entry = readState(repository).reviews['docs/README.md'];
  const files = new Map(entry.files.map(file => [file.path, file.blob]));
  const binaryBlob = runGit(repository, ['hash-object', '--no-filters', 'docs/picture.bin']).trim();
  const linkBlob = runGit(repository, ['hash-object', '--stdin'], { input: Buffer.from('target.txt') }).trim();

  assert.equal(files.get('docs/picture.bin'), binaryBlob);
  assert.equal(files.get('docs/link-to-target'), linkBlob);
  assert.notEqual(linkBlob, runGit(repository, ['hash-object', '--no-filters', 'docs/target.txt']).trim());
});

test('help documents the review command', () => {
  const result = runCli(['--help'], os.tmpdir());
  assertStatus(result, 0);
  assert.match(result.stdout, /\breview\b/i);
});
