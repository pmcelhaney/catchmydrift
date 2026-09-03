const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFileSync, spawnSync } = childProcess;
const catchmydrift = require('../index');
const cliEntryPoint = path.resolve(__dirname, '..', 'index.js');

test('flatten combines nested arrays one level', () => {
  assert.deepEqual(catchmydrift.flatten([[1, 2], [3], []]), [1, 2, 3]);
});

test('percentFormat rounds and pads to expected width', () => {
  assert.equal(catchmydrift.percentFormat(0.8663), ' 86.63%');
});

test('getDirectories returns only direct child directories', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-test-'));
  fs.mkdirSync(path.join(tempRoot, 'a'));
  fs.mkdirSync(path.join(tempRoot, 'b'));
  fs.writeFileSync(path.join(tempRoot, 'file.txt'), 'x');

  const directories = catchmydrift.getDirectories(tempRoot).map(p => path.basename(p)).sort();
  assert.deepEqual(directories, ['a', 'b']);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('getDirectoriesRecursive includes root and nested directories', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-test-'));
  const nested = path.join(tempRoot, 'one', 'two');
  fs.mkdirSync(nested, { recursive: true });

  const directories = catchmydrift.getDirectoriesRecursive(tempRoot).sort();
  assert.deepEqual(
    directories,
    [
      tempRoot,
      path.join(tempRoot, 'one'),
      nested
    ].sort()
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('countInsertionsAndDeletionsSinceHash parses git shortstat output', () => {
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = () => '1 file changed, 5 insertions(+), 3 deletions(-)\n';

  try {
    assert.equal(catchmydrift.countInsertionsAndDeletionsSinceHash('hash', '.'), 8);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
  }
});

function runGit(directory, args) {
  execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

function createCliFixture(t, { includeMissing = false } = {}) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-cli-test-'));
  const docsDirectory = path.join(repository, 'docs');
  fs.mkdirSync(docsDirectory, { recursive: true });
  if (includeMissing) {
    fs.mkdirSync(path.join(docsDirectory, 'missing'));
  }
  fs.writeFileSync(path.join(docsDirectory, 'README.md'), '# Documentation\n');
  fs.writeFileSync(path.join(docsDirectory, 'example.txt'), 'before\n');

  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'catchmydrift test']);
  runGit(repository, ['add', 'docs/README.md']);
  runGit(repository, ['commit', '--quiet', '-m', 'add readme']);
  runGit(repository, ['add', 'docs/example.txt']);
  runGit(repository, ['commit', '--quiet', '-m', 'add related file']);

  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return repository;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliEntryPoint, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

test('CLI help presents catchmydrift usage without scanning a repository', () => {
  const result = runCli(['--help'], process.cwd());

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /catchmydrift/i);
  assert.match(result.stdout, /--threshold/);
});

test('CLI version reports the package version', () => {
  const result = runCli(['--version'], process.cwd());

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '1.0.0');
});

test('CLI accepts --threshold to suppress a score at the threshold', t => {
  const repository = createCliFixture(t);
  const result = runCli(['--threshold', '100', 'docs'], repository);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('CLI no longer accepts the misspelled --threshhold option', t => {
  const repository = createCliFixture(t);
  const result = runCli(['--threshhold', '100', 'docs'], repository);

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'the removed option must not suppress the drift result');
});

test('CLI no longer accepts --skipMissing', t => {
  const repository = createCliFixture(t, { includeMissing: true });
  const result = runCli(['--threshold', '100', '--skipMissing', 'docs'], repository);

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'the removed option must not suppress missing README reporting');
});
