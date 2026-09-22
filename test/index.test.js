const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cliEntryPoint = path.resolve(__dirname, '..', 'index.js');

function runGit(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

function writeFile(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function createRepository(t, files = {}) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-test-'));
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'catchmydrift test']);

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
  return spawnSync(process.execPath, [cliEntryPoint, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

function assertSucceeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertFailedForDrift(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr || result.stdout);
}

test('zero-config inspection covers root, nested, and multiple lowercase Markdown files', t => {
  const repository = createRepository(t, {
    'README.md': '# Root\n',
    'guide/README.md': '# Guide\n',
    'guide/howto.md': '# How to\n',
    'guide/service.js': 'module.exports = 1;\n',
    'other/README.MD': '# Not a candidate\n',
    'other/service.js': 'module.exports = 1;\n'
  });

  writeFile(repository, 'guide/service.js', 'module.exports = 2;\n');
  const result = runCli([], repository);

  assertFailedForDrift(result);
  assert.match(result.stdout, /guide[\\/]README\.md/);
  assert.match(result.stdout, /guide[\\/]howto\.md/);
  assert.doesNotMatch(result.stdout, /README\.MD/);
});

test('directories without a tracked lowercase Markdown file are ignored', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'source/only-code.js': 'module.exports = 1;\n'
  });

  writeFile(repository, 'source/only-code.js', 'module.exports = 2;\n');
  const result = runCli([], repository);

  assertSucceeded(result);
  assert.doesNotMatch(result.stdout, /only-code\.js/);
});

test('the checked content includes both staged and unstaged tracked changes', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.js': 'one\n'
  });

  writeFile(repository, 'docs/service.js', 'two\n');
  runGit(repository, ['add', 'docs/service.js']);
  assertFailedForDrift(runCli([], repository));

  writeFile(repository, 'docs/service.js', 'two\nthree\n');

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /docs[\\/]README\.md/);
});

test('insertions and deletions use current related text lines, with equality allowed at the threshold', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'one\n'
  });

  writeFile(repository, 'docs/service.txt', 'ONE\n');

  assertSucceeded(runCli(['--threshold', '100'], repository));
  assertFailedForDrift(runCli(['--threshold', '99'], repository));
});

test('zero-config checks default to a 20 percent drift threshold', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n'
  });

  writeFile(repository, 'docs/service.txt', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');

  const result = runCli([], repository);

  assertSucceeded(result);
  assert.match(result.stdout, /20\.00% threshold/);
});

test('ignored and untracked files do not create drift', t => {
  const repository = createRepository(t, {
    '.gitignore': 'ignored.txt\n',
    'docs/README.md': '# Docs\n',
    'docs/service.js': 'module.exports = 1;\n'
  });

  writeFile(repository, 'docs/ignored.txt', 'ignored\n');
  writeFile(repository, 'docs/untracked.txt', 'untracked\n');

  const result = runCli([], repository);
  assertSucceeded(result);
  assert.doesNotMatch(result.stdout, /ignored\.txt|untracked\.txt/);
});

test('a subdirectory root limits candidates and related files to that subtree', t => {
  const repository = createRepository(t, {
    'README.md': '# Root\n',
    'outside.js': 'before\n',
    'nested/README.md': '# Nested\n',
    'nested/service.js': 'before\n'
  });

  writeFile(repository, 'outside.js', 'after\n');
  writeFile(repository, 'nested/service.js', 'after\n');

  const result = runCli(['nested'], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
  assert.doesNotMatch(result.stdout, /outside\.js|^.*\bRoot\b.*$/m);
});

test('paths with spaces and shell metacharacters are passed safely to Git', t => {
  const unusualDirectory = 'docs with spaces; $(not-a-command)';
  const repository = createRepository(t, {
    [`${unusualDirectory}/README.md`]: '# Docs\n',
    [`${unusualDirectory}/service.js`]: 'before\n'
  });

  writeFile(repository, `${unusualDirectory}/service.js`, 'after\n');
  const result = runCli([unusualDirectory], repository);

  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
});

test('binary-only changes score zero and report a no-text warning', t => {
  const repository = createRepository(t, {
    'docs/README.md': '',
    'docs/image.bin': Buffer.from([0, 1, 2, 3])
  });

  fs.writeFileSync(path.join(repository, 'docs/image.bin'), Buffer.from([0, 9, 2, 3]));
  const result = runCli([], repository);

  assertSucceeded(result);
  assert.match(`${result.stdout}\n${result.stderr}`, /warning:.*text/i);
});

test('invalid thresholds exit with command-error status', t => {
  const repository = createRepository(t, { 'README.md': '# Root\n' });

  for (const threshold of ['-1', '101', 'not-a-number', 'Infinity']) {
    const result = runCli(['--threshold', threshold], repository);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, `${threshold}: ${result.stderr || result.stdout}`);
  }
});

test('the explicit check command is equivalent to the default command', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.js': 'before\n'
  });

  writeFile(repository, 'docs/service.js', 'after\n');
  const implicit = runCli(['docs'], repository);
  const explicit = runCli(['check', 'docs'], repository);

  assert.equal(explicit.status, implicit.status, explicit.stderr || explicit.stdout);
  assert.equal(explicit.stdout, implicit.stdout);
  assert.equal(explicit.stderr, implicit.stderr);
});

test('the state file is excluded even when it is tracked and changed', t => {
  const repository = createRepository(t, {
    '.catchmydrift-state.json': '{"version":1,"reviews":{}}\n',
    'README.md': '# Root\n',
    'docs/README.md': '# Docs\n',
    'docs/service.js': 'unchanged\n'
  });

  writeFile(repository, '.catchmydrift-state.json', '{\n  "version": 1,\n  "reviews": {}\n}\n');
  const result = runCli([], repository);

  assertSucceeded(result);
  assert.doesNotMatch(result.stdout, /catchmydrift-state/);
});

test('output path ordering is deterministic', t => {
  const repository = createRepository(t, {
    'a/README.md': '# A\n',
    'a/service.js': 'before\n',
    'z/README.md': '# Z\n',
    'z/service.js': 'before\n'
  });

  writeFile(repository, 'a/service.js', 'after\n');
  writeFile(repository, 'z/service.js', 'after\n');

  const first = runCli([], repository);
  const second = runCli([], repository);
  assertFailedForDrift(first);
  assert.equal(second.status, first.status);
  assert.equal(second.stdout, first.stdout);
  assert.equal(second.stderr, first.stderr);
  assert.ok(first.stdout.indexOf('a/README.md') < first.stdout.indexOf('z/README.md'));
});

test('help and version do not require a repository', () => {
  const help = runCli(['--help'], os.tmpdir());
  const version = runCli(['--version'], os.tmpdir());

  assertSucceeded(help);
  assert.match(help.stdout, /catchmydrift/i);
  assert.match(help.stdout, /--threshold/);
  assertSucceeded(version);
  assert.equal(version.stdout.trim(), '0.0.1');
});

test('a staged related-file deletion contributes drift', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'service\n'
  });

  fs.rmSync(path.join(repository, 'docs/service.txt'));
  runGit(repository, ['add', '-u']);

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
});

test('git rm --cached excludes a physically present related file from the current denominator', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'service\n'
  });

  runGit(repository, ['rm', '--cached', '--quiet', 'docs/service.txt']);
  assert.equal(fs.existsSync(path.join(repository, 'docs/service.txt')), true);

  const result = runCli(['--threshold', '75'], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /100\.00%.*README\.md/);
});

test('a staged watched-Markdown deletion remains reportable until committed', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'service\n'
  });

  runGit(repository, ['rm', '--quiet', 'docs/README.md']);
  const result = runCli([], repository);

  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
});

test('deleting all related current text produces 100 percent drift', t => {
  const repository = createRepository(t, {
    'docs/README.md': '',
    'docs/service.txt': 'service\n'
  });

  fs.rmSync(path.join(repository, 'docs/service.txt'));
  runGit(repository, ['add', '-u']);

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /100\.00%.*README\.md/);
});

test('a staged related-file rename is measured without a Git pathspec error', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'service\n'
  });

  runGit(repository, ['mv', 'docs/service.txt', 'docs/renamed.txt']);
  const result = runCli([], repository);

  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
});

test('an unborn repository uses the empty tree baseline', t => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-unborn-test-'));
  runGit(repository, ['init', '--quiet']);
  writeFile(repository, 'docs/README.md', '# Docs\n');
  writeFile(repository, 'docs/service.txt', 'service\n');
  runGit(repository, ['add', '.']);
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
});

test('a new staged Markdown file after HEAD is checked from the empty-tree baseline', t => {
  const repository = createRepository(t, { 'existing.txt': 'existing\n' });
  writeFile(repository, 'docs/README.md', '# Docs\n');
  writeFile(repository, 'docs/service.txt', 'service\n');
  runGit(repository, ['add', '.']);

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /docs[\\/]README\.md/);
});

test('display paths are relative to the selected scan root', t => {
  const repository = createRepository(t, {
    'nested/README.md': '# Nested\n',
    'nested/service.txt': 'before\n'
  });
  writeFile(repository, 'nested/service.txt', 'after\n');

  const result = runCli(['nested'], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
  assert.doesNotMatch(result.stdout, /nested[\\/]README\.md/);
});

test('a healthy result visibly reports the effective threshold', t => {
  const repository = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'before\n'
  });
  writeFile(repository, 'docs/service.txt', 'after\n');

  const result = runCli(['--threshold', '100'], repository);
  assertSucceeded(result);
  assert.match(result.stdout, /threshold.*100|100.*threshold/i);
});

test('summaries distinguish healthy, singular, and plural watched-file results', t => {
  const healthy = createRepository(t, { 'README.md': '# Root\n' });
  const healthyResult = runCli([], healthy);
  assertSucceeded(healthyResult);
  assert.match(healthyResult.stdout, /Healthy: 1 watched file checked; no watched files exceed/i);

  const singular = createRepository(t, {
    'docs/README.md': '# Docs\n',
    'docs/service.txt': 'before\n'
  });
  writeFile(singular, 'docs/service.txt', 'after\n');
  const singularResult = runCli([], singular);
  assertFailedForDrift(singularResult);
  assert.match(singularResult.stdout, /1 watched file checked; 1 watched file exceeds/i);

  const plural = createRepository(t, {
    'a/README.md': '# A\n',
    'a/service.txt': 'before\n',
    'b/README.md': '# B\n',
    'b/service.txt': 'before\n'
  });
  writeFile(plural, 'a/service.txt', 'after\n');
  writeFile(plural, 'b/service.txt', 'after\n');
  const pluralResult = runCli([], plural);
  assertFailedForDrift(pluralResult);
  assert.match(pluralResult.stdout, /2 watched files checked; 2 watched files exceed/i);
});

test('a watched Markdown path with Git pathspec metacharacters has a literal baseline', t => {
  const repository = createRepository(t, {
    'docs/[guide].md': '# Guide\n',
    'docs/service.txt': 'before\n'
  });
  writeFile(repository, 'docs/service.txt', 'after\n');

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /\[guide\]\.md/);
});

test('a literal backslash in a POSIX tracked path remains a literal path character', {
  skip: process.platform === 'win32' ? 'Windows does not support a backslash filename.' : false
}, t => {
  const directory = 'docs\\literal';
  const repository = createRepository(t, {
    [`${directory}/README.md`]: '# Docs\n',
    [`${directory}/service.txt`]: 'before\n'
  });
  writeFile(repository, `${directory}/service.txt`, 'after\n');

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /docs\\literal[\\/]README\.md/);
});

test('an unstaged intermediate directory symlink cannot escape the repository or selected root', {
  skip: process.platform === 'win32' ? 'Symlink permissions are not portable on Windows.' : false
}, t => {
  const repository = createRepository(t, {
    'selected/README.md': '# Selected\n',
    'selected/linked/README.md': '# Tracked child\n',
    'selected/linked/service.txt': 'tracked service\n',
    'elsewhere/README.md': '# Elsewhere secret\n'
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-symlink-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  writeFile(outside, 'README.md', '# Outside secret\n');

  const linkedPath = path.join(repository, 'selected/linked');
  fs.rmSync(linkedPath, { recursive: true, force: true });
  fs.symlinkSync(outside, linkedPath, 'dir');
  const outsideResult = runCli(['selected'], repository);
  assert.ok([1, 2].includes(outsideResult.status), outsideResult.stderr || outsideResult.stdout);
  assert.doesNotMatch(`${outsideResult.stdout}\n${outsideResult.stderr}`, /Outside secret/);

  fs.unlinkSync(linkedPath);
  fs.symlinkSync('../elsewhere', linkedPath, 'dir');
  const inRepositoryResult = runCli(['selected'], repository);
  assert.ok([1, 2].includes(inRepositoryResult.status), inRepositoryResult.stderr || inRepositoryResult.stdout);
  assert.doesNotMatch(`${inRepositoryResult.stdout}\n${inRepositoryResult.stderr}`, /Elsewhere secret/);

  fs.unlinkSync(linkedPath);
  writeFile(repository, 'selected/inside-target/README.md', `${'untracked line\n'.repeat(500)}`);
  fs.symlinkSync('inside-target', linkedPath, 'dir');
  const untrackedTargetResult = runCli(['--threshold', '1', 'selected'], repository);
  assertFailedForDrift(untrackedTargetResult);
  assert.match(untrackedTargetResult.stdout, /100\.00%.*README\.md/);
});

test('a final symlink is counted as link text without dereferencing it', {
  skip: process.platform === 'win32' ? 'Symlink permissions are not portable on Windows.' : false
}, t => {
  const repository = createRepository(t, { 'docs/README.md': '# Docs\n' });
  fs.symlinkSync('first-target', path.join(repository, 'docs/link.txt'));
  runGit(repository, ['add', 'docs/link.txt']);
  commitAll(repository, 'add link');
  fs.unlinkSync(path.join(repository, 'docs/link.txt'));
  fs.symlinkSync('second-target', path.join(repository, 'docs/link.txt'));
  runGit(repository, ['add', 'docs/link.txt']);

  const result = runCli([], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
});

test('Git diff attributes can force text measurement or explicitly suppress it', t => {
  const forced = createRepository(t, {
    '.gitattributes': 'docs/forced.dat diff\n',
    'docs/README.md': '',
    'docs/forced.dat': Buffer.from('before\0\n')
  });
  writeFile(forced, 'docs/forced.dat', Buffer.from('after\0\n'));
  assertFailedForDrift(runCli(['--threshold', '100'], forced));

  const suppressed = createRepository(t, {
    '.gitattributes': 'docs/suppressed.dat -diff\n',
    'docs/README.md': '# Docs\n',
    'docs/suppressed.dat': 'before\n'
  });
  writeFile(suppressed, 'docs/suppressed.dat', 'after\n');
  assertSucceeded(runCli([], suppressed));
});

test('missing roots, non-repository roots, unknown options, and extra positionals exit 2', t => {
  const repository = createRepository(t, { 'README.md': '# Root\n' });
  const nonRepository = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-nonrepo-test-'));
  t.after(() => fs.rmSync(nonRepository, { recursive: true, force: true }));

  for (const [args, cwd] of [
    [['missing-directory'], repository],
    [[], nonRepository],
    [['--unknown-option'], repository],
    [['one', 'two'], repository]
  ]) {
    const result = runCli(args, cwd);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, result.stderr || result.stdout);
  }
});

test('double-dash makes check a literal scan-root name rather than a command', t => {
  const repository = createRepository(t, {
    'check/README.md': '# Check\n',
    'check/service.txt': 'before\n'
  });
  writeFile(repository, 'check/service.txt', 'after\n');

  const result = runCli(['--', 'check'], repository);
  assertFailedForDrift(result);
  assert.match(result.stdout, /README\.md/);
});
