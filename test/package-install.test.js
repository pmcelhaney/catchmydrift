const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const packageManifest = require('../package.json');

function runGit(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

function writeFile(directory, relativePath, contents) {
  const filePath = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function packPackage(directory, destination, cache) {
  const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache }
  });
  const [packed] = JSON.parse(output);
  return {
    tarball: path.join(destination, packed.filename),
    files: packed.files.map(file => file.path).sort()
  };
}

function runInstalledCli(binary, args, cwd) {
  return spawnSync(binary, args, { cwd, encoding: 'utf8' });
}

function assertStatus(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

function createRepository(directory, files) {
  fs.mkdirSync(directory, { recursive: true });
  runGit(directory, ['init', '--quiet']);
  runGit(directory, ['config', 'user.email', 'test@example.com']);
  runGit(directory, ['config', 'user.name', 'catchmydrift package test']);
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(directory, relativePath, contents);
  }
  runGit(directory, ['add', '.']);
  runGit(directory, ['commit', '--quiet', '-m', 'initial fixture']);
}

function commitAll(directory, message) {
  runGit(directory, ['add', '.']);
  runGit(directory, ['commit', '--quiet', '-m', message]);
}

test('the packed package installs locally and its installed CLI covers check, config, and review', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-package-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const cache = path.join(temporary, 'npm-cache');
  const packages = path.join(temporary, 'packages');
  fs.mkdirSync(packages, { recursive: true });

  const packedApplication = packPackage(packageRoot, packages, cache);
  const packedDependencies = [
    packPackage(path.join(packageRoot, 'node_modules/minimatch'), packages, cache),
    packPackage(path.join(packageRoot, 'node_modules/brace-expansion'), packages, cache),
    packPackage(path.join(packageRoot, 'node_modules/balanced-match'), packages, cache)
  ];

  assert.deepEqual(packedApplication.files, [
    'LICENSE',
    'README.md',
    'catchmydrift.schema.json',
    'index.js',
    'lib/config.js',
    'lib/drift.js',
    'lib/git.js',
    'lib/review-state.js',
    'package.json'
  ]);
  for (const packedPath of packedApplication.files) {
    assert.doesNotMatch(packedPath, /(^|\/)(?:AGENTS\.md|test|docdr|docdelta)(?:\/|$)/i);
  }

  const consumer = path.join(temporary, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  const dependencies = Object.fromEntries([
    ['catchmydrift', packedApplication.tarball],
    ['minimatch', packedDependencies[0].tarball],
    ['brace-expansion', packedDependencies[1].tarball],
    ['balanced-match', packedDependencies[2].tarball]
  ].map(([name, tarball]) => [name, `file:${tarball}`]));
  writeFile(consumer, 'package.json', `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`);
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumer,
    stdio: 'pipe',
    env: { ...process.env, npm_config_cache: cache }
  });

  const binary = path.join(consumer, 'node_modules', '.bin', 'catchmydrift');
  assert.equal(fs.existsSync(binary), true);
  const help = runInstalledCli(binary, ['--help'], temporary);
  assertStatus(help, 0);
  assert.match(help.stdout, /catchmydrift review/i);
  const version = runInstalledCli(binary, ['--version'], temporary);
  assertStatus(version, 0);
  assert.equal(version.stdout.trim(), packageManifest.version);

  const repository = path.join(temporary, 'repository');
  createRepository(repository, {
    'docs/README.md': '# Documentation\n',
    'docs/service.txt': 'before\n'
  });
  assertStatus(runInstalledCli(binary, ['check'], repository), 0);
  writeFile(repository, 'docs/service.txt', 'after\n');
  const zeroConfigDrift = runInstalledCli(binary, ['check'], repository);
  assertStatus(zeroConfigDrift, 1);
  assert.match(zeroConfigDrift.stdout, /docs\/README\.md/);
  writeFile(repository, 'docs/service.txt', 'before\n');

  const config = {
    groups: { source: { include: ['source/**'] } },
    watch: [{ include: ['instructions/manual.txt'], groups: ['source'] }]
  };
  writeFile(repository, 'catchmydrift.config.json', `${JSON.stringify(config, null, 2)}\n`);
  writeFile(repository, 'instructions/manual.txt', 'Keep the service current.\n');
  writeFile(repository, 'source/service.txt', 'before\n');
  commitAll(repository, 'add configured fixture');
  writeFile(repository, 'source/service.txt', 'after\n');
  const configuredDrift = runInstalledCli(binary, ['check'], repository);
  assertStatus(configuredDrift, 1);
  assert.match(configuredDrift.stdout, /instructions\/manual\.txt/);

  const review = runInstalledCli(binary, ['review', 'instructions/manual.txt', '--root', repository], repository);
  assertStatus(review, 0);
  assert.match(review.stdout, /Approved: instructions\/manual\.txt/);
  assert.equal(fs.existsSync(path.join(repository, '.catchmydrift-state.json')), true);
  assertStatus(runInstalledCli(binary, ['check'], repository), 0);
  commitAll(repository, 'persist reviewed configuration and source');
  assertStatus(runInstalledCli(binary, ['check'], repository), 0);

  const invalidThreshold = runInstalledCli(binary, ['check', '--threshold', '101'], repository);
  assertStatus(invalidThreshold, 2);
});
