'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  OperationalError,
  comparePaths,
  commitsForPath,
  hashObject,
  isStatePath,
  listTreeEntries,
  readFileAtCommit
} = require('./git');
const { safelyReadRelatedFile } = require('./drift');

const STATE_FILENAME = '.catchmydrift-state.json';
const STATE_VERSION = 1;
const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class StateHealthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StateHealthError';
    this.cause = cause;
  }
}

function stateRepositoryPath(scan) {
  return scan.rootRelative === '.' ? STATE_FILENAME : `${scan.rootRelative}/${STATE_FILENAME}`;
}

function emptyState() {
  return { version: STATE_VERSION, reviews: Object.create(null) };
}

function snapshotDigest(files) {
  const canonicalFiles = files.map(file => ({ path: file.path, blob: file.blob }));
  return crypto.createHash('sha256').update(JSON.stringify(canonicalFiles)).digest('hex');
}

function isNormalizedRepositoryPath(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== '..' &&
    !value.startsWith('../');
}

function isInsideScan(scan, repositoryPath) {
  return scan.rootRelative === '.' || repositoryPath.startsWith(`${scan.rootRelative}/`);
}

function assertExactKeys(value, expected, location) {
  const actual = Object.keys(value).sort(comparePaths);
  const wanted = [...expected].sort(comparePaths);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new StateHealthError(`${location} has an invalid shape.`);
  }
}

function validateState(value, scan, source = 'Review state') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateHealthError(`${source} must be a JSON object.`);
  }
  assertExactKeys(value, ['version', 'reviews'], source);
  if (value.version !== STATE_VERSION) {
    throw new StateHealthError(`${source} uses unsupported version: ${JSON.stringify(value.version)}`);
  }
  if (value.reviews === null || typeof value.reviews !== 'object' || Array.isArray(value.reviews)) {
    throw new StateHealthError(`${source} reviews must be a JSON object.`);
  }

  const seenTokens = new Set();
  const reviews = Object.create(null);
  for (const [watchedPath, entry] of Object.entries(value.reviews)) {
    if (!isNormalizedRepositoryPath(watchedPath) || !isInsideScan(scan, watchedPath) || isStatePath(watchedPath)) {
      throw new StateHealthError(`${source} contains an invalid watched path: ${JSON.stringify(watchedPath)}`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new StateHealthError(`${source} review for ${watchedPath} must be an object.`);
    }
    assertExactKeys(entry, ['token', 'relationship', 'snapshotDigest', 'files'], `${source} review for ${watchedPath}`);
    if (typeof entry.token !== 'string' || !UUID_PATTERN.test(entry.token) || seenTokens.has(entry.token)) {
      throw new StateHealthError(`${source} review for ${watchedPath} has an invalid or duplicate token.`);
    }
    seenTokens.add(entry.token);
    if (typeof entry.relationship !== 'string' || !DIGEST_PATTERN.test(entry.relationship)) {
      throw new StateHealthError(`${source} review for ${watchedPath} has an invalid relationship signature.`);
    }
    if (typeof entry.snapshotDigest !== 'string' || !DIGEST_PATTERN.test(entry.snapshotDigest)) {
      throw new StateHealthError(`${source} review for ${watchedPath} has an invalid snapshot digest.`);
    }
    if (!Array.isArray(entry.files)) {
      throw new StateHealthError(`${source} review for ${watchedPath} files must be an array.`);
    }
    let priorPath = null;
    for (const file of entry.files) {
      if (file === null || typeof file !== 'object' || Array.isArray(file)) {
        throw new StateHealthError(`${source} review for ${watchedPath} has an invalid file record.`);
      }
      assertExactKeys(file, ['path', 'blob'], `${source} review file for ${watchedPath}`);
      if (
        !isNormalizedRepositoryPath(file.path) ||
        !isInsideScan(scan, file.path) ||
        isStatePath(file.path) ||
        (priorPath !== null && comparePaths(priorPath, file.path) >= 0)
      ) {
        throw new StateHealthError(`${source} review for ${watchedPath} has an invalid or unsorted file path.`);
      }
      if (file.blob !== null && (typeof file.blob !== 'string' || !HASH_PATTERN.test(file.blob))) {
        throw new StateHealthError(`${source} review for ${watchedPath} has an invalid blob object ID.`);
      }
      priorPath = file.path;
    }
    if (snapshotDigest(entry.files) !== entry.snapshotDigest) {
      throw new StateHealthError(`${source} review for ${watchedPath} has an inconsistent snapshot digest.`);
    }
    reviews[watchedPath] = entry;
  }
  return { version: STATE_VERSION, reviews };
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

function createSnapshot(scan, repositoryRoot, relatedPaths) {
  const files = [...new Set(relatedPaths)].sort(comparePaths).map(relativePath => {
    const entry = safelyReadRelatedFile(scan.scanRoot, repositoryRoot, relativePath);
    return {
      path: relativePath,
      blob: entry === null ? null : hashObject(repositoryRoot, entry.contents)
    };
  });
  return { files, snapshotDigest: snapshotDigest(files) };
}

function createReviewEntry(scan, planEntry) {
  const snapshot = createSnapshot(scan, scan.repositoryRoot, planEntry.currentRelatedPaths);
  return {
    token: crypto.randomUUID(),
    relationship: planEntry.relationship,
    snapshotDigest: snapshot.snapshotDigest,
    files: snapshot.files
  };
}

function serializeState(state) {
  const reviews = Object.create(null);
  for (const watchedPath of Object.keys(state.reviews).sort(comparePaths)) {
    const entry = state.reviews[watchedPath];
    reviews[watchedPath] = {
      token: entry.token,
      relationship: entry.relationship,
      snapshotDigest: entry.snapshotDigest,
      files: [...entry.files].sort((left, right) => comparePaths(left.path, right.path))
    };
  }
  return `${JSON.stringify({ version: STATE_VERSION, reviews }, null, 2)}\n`;
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

function entriesEqual(left, right) {
  return left.token === right.token &&
    left.relationship === right.relationship &&
    left.snapshotDigest === right.snapshotDigest &&
    filesEqual(left.files, right.files);
}

function filesEqual(left, right) {
  return left.length === right.length && left.every((file, index) =>
    file.path === right[index].path && file.blob === right[index].blob
  );
}

function findTokenCommit(scan, watchedPath, entry) {
  const statePath = stateRepositoryPath(scan);
  let introducingCommit = null;
  for (const commit of commitsForPath(scan.repositoryRoot, statePath)) {
    const contents = readFileAtCommit(scan.repositoryRoot, commit, statePath);
    if (contents === null) {
      continue;
    }
    let historical;
    try {
      historical = parseState(contents.toString('utf8'), scan, `Review state at commit ${commit}`);
    } catch (error) {
      if (contents.includes(Buffer.from(entry.token))) {
        throw new StateHealthError(`Approval token for ${watchedPath} occurs in invalid review state at commit ${commit}.`, error);
      }
      continue;
    }
    const occurrences = Object.entries(historical.reviews).filter(([, candidate]) => candidate.token === entry.token);
    if (occurrences.length === 0) {
      continue;
    }
    if (occurrences.length !== 1 || occurrences[0][0] !== watchedPath || !entriesEqual(occurrences[0][1], entry)) {
      throw new StateHealthError(`Approval token for ${watchedPath} is inconsistent at commit ${commit}.`);
    }
    if (introducingCommit === null) {
      introducingCommit = commit;
    }
  }
  return introducingCommit;
}

function verifyPendingSnapshot(scan, planEntry, entry) {
  const current = createSnapshot(scan, scan.repositoryRoot, planEntry.currentRelatedPaths);
  return filesEqual(current.files, entry.files) && current.snapshotDigest === entry.snapshotDigest;
}

function verifyCommittedSnapshot(scan, planEntry, entry, commit) {
  const stored = new Map(entry.files.map(file => [file.path, file.blob]));
  const matchedTreePaths = new Set();
  for (const treeEntry of listTreeEntries(scan.repositoryRoot, commit, scan.rootRelative)) {
    if (isStatePath(treeEntry.path) || !planEntry.matchesRelationship(treeEntry.path)) {
      continue;
    }
    matchedTreePaths.add(treeEntry.path);
    if (treeEntry.type !== 'blob' || stored.get(treeEntry.path) !== treeEntry.objectId) {
      return false;
    }
  }
  for (const file of entry.files) {
    if (!planEntry.matchesRelationship(file.path)) {
      return false;
    }
    if (file.blob === null) {
      if (matchedTreePaths.has(file.path)) {
        return false;
      }
    } else if (!matchedTreePaths.has(file.path)) {
      return false;
    }
  }
  return matchedTreePaths.size === entry.files.filter(file => file.blob !== null).length;
}

module.exports = {
  STATE_FILENAME,
  STATE_VERSION,
  StateHealthError,
  stateRepositoryPath,
  emptyState,
  snapshotDigest,
  validateState,
  parseState,
  loadState,
  createSnapshot,
  createReviewEntry,
  serializeState,
  writeStateAtomically,
  findTokenCommit,
  verifyPendingSnapshot,
  verifyCommittedSnapshot
};
