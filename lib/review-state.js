'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { OperationalError, comparePaths, isStatePath, runGit } = require('./git');

const STATE_FILENAME = '.catchmydrift-state.json';
const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class StateHealthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StateHealthError';
    this.cause = cause;
  }
}

function emptyState() {
  return Object.create(null);
}

function validateState(value, scan, source = 'Review state') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateHealthError(`${source} must be a document-to-commit-SHA object.`);
  }
  const state = emptyState();
  for (const [watchedPath, commit] of Object.entries(value)) {
    if (!watchedPath || watchedPath.includes('\0') || path.posix.isAbsolute(watchedPath) ||
        path.posix.normalize(watchedPath) !== watchedPath || watchedPath === '.' ||
        watchedPath.endsWith('/') || watchedPath === '..' ||
        watchedPath.startsWith('../') || isStatePath(watchedPath) ||
        (scan.rootRelative !== '.' && !watchedPath.startsWith(`${scan.rootRelative}/`))) {
      throw new StateHealthError(`${source} contains an invalid watched path: ${JSON.stringify(watchedPath)}`);
    }
    if (typeof commit !== 'string' || !HASH_PATTERN.test(commit)) {
      throw new StateHealthError(`${source} review for ${watchedPath} must be a full commit SHA.`);
    }
    const type = runGit(['cat-file', '-t', commit], scan.repositoryRoot, { allowFailure: true });
    if (type.status !== 0 || type.stdout.toString('utf8').trim() !== 'commit' ||
        runGit(['merge-base', '--is-ancestor', commit, 'HEAD'], scan.repositoryRoot, { allowFailure: true }).status !== 0) {
      throw new StateHealthError(`${source} review for ${watchedPath} is not a commit reachable from HEAD: ${commit}`);
    }
    state[watchedPath] = commit;
  }
  return state;
}

function parseState(contents, scan, source) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new StateHealthError(`${source} contains invalid JSON.`, error);
  }
  return validateState(value, scan, source);
}

function loadState(scan) {
  const statePath = path.join(scan.scanRoot, STATE_FILENAME);
  let stat;
  try {
    stat = fs.lstatSync(statePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { state: emptyState(), exists: false, path: statePath };
    }
    throw new StateHealthError(`Unable to inspect review state: ${statePath}`, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new StateHealthError(`Review state must be a regular file: ${statePath}`);
  }
  let contents;
  try {
    contents = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    throw new StateHealthError(`Unable to read review state: ${statePath}`, error);
  }
  return { state: parseState(contents, scan, 'Review state'), exists: true, path: statePath };
}

function serializeState(state) {
  const ordered = Object.create(null);
  for (const watchedPath of Object.keys(state).sort(comparePaths)) {
    ordered[watchedPath] = state[watchedPath];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function writeStateAtomically(scan, state) {
  validateState(state, scan);
  const target = path.join(scan.scanRoot, STATE_FILENAME);
  const temporary = path.join(
    scan.scanRoot,
    `${STATE_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, serializeState(state), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new OperationalError(`Unable to clean up temporary review state: ${temporary}`, cleanupError);
      }
    }
    throw new OperationalError(`Unable to update review state: ${target}`, error);
  }
}

module.exports = {
  STATE_FILENAME,
  StateHealthError,
  emptyState,
  validateState,
  parseState,
  loadState,
  serializeState,
  writeStateAtomically
};
