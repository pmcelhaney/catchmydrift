'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

class OperationalError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'OperationalError';
    this.cause = cause;
  }
}

function runGit(args, cwd, options = {}) {
  try {
    const stdout = childProcess.execFileSync('git', args, {
      cwd,
      encoding: 'buffer',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_LITERAL_PATHSPECS: '1'
      }
    });
    return { status: 0, stdout, stderr: Buffer.alloc(0) };
  } catch (error) {
    const stdout = Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.alloc(0);
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.alloc(0);
    const status = Number.isInteger(error.status) ? error.status : 1;
    if (options.allowFailure) {
      return { status, stdout, stderr };
    }
    const detail = stderr.toString('utf8').trim();
    throw new OperationalError(detail || `Git exited with status ${status}.`, error);
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeScanRoot(rootArgument, cwd = process.cwd()) {
  const requestedRoot = path.resolve(cwd, rootArgument || '.');
  let scanRoot;
  try {
    scanRoot = fs.realpathSync.native(requestedRoot);
  } catch (error) {
    throw new OperationalError(`Scan root does not exist: ${requestedRoot}`, error);
  }

  let stat;
  try {
    stat = fs.statSync(scanRoot);
  } catch (error) {
    throw new OperationalError(`Unable to inspect scan root: ${scanRoot}`, error);
  }
  if (!stat.isDirectory()) {
    throw new OperationalError(`Scan root must be a directory: ${scanRoot}`);
  }

  const repositoryResult = runGit(['rev-parse', '--show-toplevel'], scanRoot, { allowFailure: true });
  if (repositoryResult.status !== 0) {
    throw new OperationalError(`Scan root is not inside a Git repository: ${scanRoot}`);
  }

  const repositoryPath = repositoryResult.stdout.toString('utf8').trim();
  if (!repositoryPath) {
    throw new OperationalError(`Git did not report a repository root for: ${scanRoot}`);
  }

  let repositoryRoot;
  try {
    repositoryRoot = fs.realpathSync.native(repositoryPath);
  } catch (error) {
    throw new OperationalError(`Unable to resolve Git repository root: ${repositoryPath}`, error);
  }

  if (!isWithin(repositoryRoot, scanRoot)) {
    throw new OperationalError('Selected scan root escapes its Git repository.');
  }

  const rootRelative = path.relative(repositoryRoot, scanRoot).split(path.sep).join('/');
  return {
    scanRoot,
    repositoryRoot,
    rootRelative: rootRelative || '.'
  };
}

function splitNullDelimited(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStatePath(relativePath) {
  return path.posix.basename(relativePath) === '.catchmydrift-state.json';
}

function listIndexFiles(repositoryRoot, rootRelative) {
  return splitNullDelimited(
    runGit(['ls-files', '-z', '--', rootRelative], repositoryRoot).stdout
  ).filter(filePath => !isStatePath(filePath)).sort(comparePaths);
}

function listTrackedFiles(repositoryRoot, rootRelative) {
  const paths = new Set(listIndexFiles(repositoryRoot, rootRelative));

  if (hasHead(repositoryRoot)) {
    const headPaths = runGit(
      ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', rootRelative],
      repositoryRoot
    );
    for (const filePath of splitNullDelimited(headPaths.stdout)) {
      paths.add(filePath);
    }
  }

  return [...paths]
    .filter(filePath => !isStatePath(filePath))
    .sort(comparePaths);
}

function hasHead(repositoryRoot) {
  return runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repositoryRoot, { allowFailure: true }).status === 0;
}

function baselineForPath(repositoryRoot, relativePath) {
  if (!hasHead(repositoryRoot)) {
    return EMPTY_TREE_HASH;
  }

  const result = runGit(['log', '-n', '1', '--format=%H', '--', relativePath], repositoryRoot);
  const baseline = result.stdout.toString('utf8').trim();
  return baseline || EMPTY_TREE_HASH;
}

function diffNumstat(repositoryRoot, baseline, relativePaths, options = {}) {
  if (relativePaths.length === 0) {
    return [];
  }

  const args = ['diff'];
  if (options.cached) {
    args.push('--cached');
  }
  args.push('--no-renames', '--numstat', '-z', baseline, '--', ...relativePaths);
  const result = runGit(args, repositoryRoot);

  return splitNullDelimited(result.stdout).map(record => {
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new OperationalError('Git returned an invalid numstat record.');
    }
    return {
      inserted: record.slice(0, firstTab),
      deleted: record.slice(firstTab + 1, secondTab),
      path: record.slice(secondTab + 1)
    };
  });
}

function diffAttributesForPaths(repositoryRoot, relativePaths) {
  if (relativePaths.length === 0) {
    return new Map();
  }

  const result = runGit(['check-attr', '-z', 'diff', '--', ...relativePaths], repositoryRoot);
  const fields = splitNullDelimited(result.stdout);
  if (fields.length % 3 !== 0) {
    throw new OperationalError('Git returned an invalid attribute record.');
  }

  const attributes = new Map();
  for (let index = 0; index < fields.length; index += 3) {
    const [filePath, attribute, value] = fields.slice(index, index + 3);
    if (attribute === 'diff') {
      attributes.set(filePath, value);
    }
  }
  return attributes;
}

module.exports = {
  EMPTY_TREE_HASH,
  GIT_MAX_BUFFER,
  OperationalError,
  runGit,
  isWithin,
  normalizeScanRoot,
  listIndexFiles,
  listTrackedFiles,
  baselineForPath,
  diffNumstat,
  diffAttributesForPaths,
  isStatePath,
  comparePaths
};
