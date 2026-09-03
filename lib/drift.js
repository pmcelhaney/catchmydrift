'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  OperationalError,
  baselineForPath,
  diffNumstat,
  diffAttributesForPaths,
  comparePaths
} = require('./git');

function isMarkdownPath(relativePath) {
  return relativePath.endsWith('.md');
}

function directoryFor(relativePath) {
  const directory = path.posix.dirname(relativePath);
  return directory === '.' ? '' : directory;
}

function isRelatedTo(watchedPath, candidatePath) {
  const directory = directoryFor(watchedPath);
  return directory === '' || candidatePath.startsWith(`${directory}/`);
}

function isTextBuffer(contents) {
  return !contents.includes(0);
}

function countTextLines(contents) {
  if (contents.length === 0) {
    return 0;
  }

  let newlines = 0;
  for (const byte of contents) {
    if (byte === 10) {
      newlines += 1;
    }
  }
  return contents[contents.length - 1] === 10 ? newlines : newlines + 1;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertWithinRoots(scanRoot, repositoryRoot, candidate, relativePath) {
  if (!isWithin(repositoryRoot, candidate) || !isWithin(scanRoot, candidate)) {
    throw new OperationalError(`Tracked path escapes the selected scan root: ${relativePath}`);
  }
}

function safelyReadRelatedFile(scanRoot, repositoryRoot, relativePath) {
  const segments = relativePath.split('/');
  const lexicalPath = path.resolve(repositoryRoot, ...segments);
  assertWithinRoots(scanRoot, repositoryRoot, lexicalPath, relativePath);

  let currentPath = repositoryRoot;
  for (const segment of segments.slice(0, -1)) {
    currentPath = path.resolve(currentPath, segment);
    assertWithinRoots(scanRoot, repositoryRoot, currentPath, relativePath);

    let stat;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new OperationalError(`Unable to inspect related file: ${relativePath}`, error);
    }
    if (stat.isSymbolicLink()) {
      return null;
    }
    if (!stat.isDirectory()) {
      throw new OperationalError(`Tracked path has a non-directory parent: ${relativePath}`);
    }
  }

  const finalPath = path.resolve(currentPath, segments[segments.length - 1]);
  assertWithinRoots(scanRoot, repositoryRoot, finalPath, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(finalPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new OperationalError(`Unable to inspect related file: ${relativePath}`, error);
  }

  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'symlink', contents: fs.readlinkSync(finalPath, 'buffer') };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new OperationalError(`Unable to read related symbolic link: ${relativePath}`, error);
    }
  }
  if (!stat.isFile()) {
    return null;
  }

  let resolvedFile;
  try {
    resolvedFile = fs.realpathSync.native(finalPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new OperationalError(`Unable to resolve related file: ${relativePath}`, error);
  }
  assertWithinRoots(scanRoot, repositoryRoot, resolvedFile, relativePath);

  try {
    return { kind: 'file', contents: fs.readFileSync(finalPath) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new OperationalError(`Unable to read related file: ${relativePath}`, error);
  }
}

function isTextEntry(entry, diffAttribute) {
  if (diffAttribute === 'unset') {
    return false;
  }
  if (entry.kind === 'symlink' || diffAttribute === 'set') {
    return true;
  }
  return isTextBuffer(entry.contents);
}

function countCurrentTextLines(scanRoot, repositoryRoot, relatedPaths, diffAttributes = new Map()) {
  let lines = 0;
  let textFiles = 0;

  for (const relatedPath of relatedPaths) {
    const entry = safelyReadRelatedFile(scanRoot, repositoryRoot, relatedPath);
    if (entry === null || !isTextEntry(entry, diffAttributes.get(relatedPath))) {
      continue;
    }
    textFiles += 1;
    lines += countTextLines(entry.contents);
  }

  return { lines, textFiles };
}

function sumTextChanges(numstat) {
  return numstat.reduce((total, entry) => {
    if (entry.inserted === '-' || entry.deleted === '-') {
      return total;
    }
    const inserted = Number(entry.inserted);
    const deleted = Number(entry.deleted);
    if (!Number.isSafeInteger(inserted) || !Number.isSafeInteger(deleted)) {
      throw new OperationalError('Git returned an invalid text numstat count.');
    }
    return total + inserted + deleted;
  }, 0);
}

function calculateDrift(scanRoot, repositoryRoot, watchedPath, trackedPaths, indexPaths = trackedPaths) {
  const relatedPaths = trackedPaths.filter(candidatePath => isRelatedTo(watchedPath, candidatePath));
  const indexPathSet = indexPaths instanceof Set ? indexPaths : new Set(indexPaths);
  const currentRelatedPaths = relatedPaths.filter(relatedPath => indexPathSet.has(relatedPath));
  const historicalOnlyPaths = relatedPaths.filter(relatedPath => !indexPathSet.has(relatedPath));
  const baseline = baselineForPath(repositoryRoot, watchedPath);
  const numstat = [
    ...diffNumstat(repositoryRoot, baseline, currentRelatedPaths),
    ...diffNumstat(repositoryRoot, baseline, historicalOnlyPaths, { cached: true })
  ];
  const changedLines = sumTextChanges(numstat);
  const diffAttributes = diffAttributesForPaths(repositoryRoot, currentRelatedPaths);
  const current = countCurrentTextLines(scanRoot, repositoryRoot, currentRelatedPaths, diffAttributes);
  let percent = 0;

  if (current.lines === 0 && changedLines > 0) {
    percent = 100;
  } else if (current.lines > 0) {
    percent = (100 * changedLines) / current.lines;
  }

  return {
    watchedPath,
    baseline,
    relatedPaths,
    currentRelatedPaths,
    changedLines,
    currentLines: current.lines,
    textFiles: current.textFiles,
    percent,
    warning: current.lines === 0
      ? 'No measurable current text lines are related to this Markdown file.'
      : numstat.length > 0 && numstat.every(entry => entry.inserted === '-' || entry.deleted === '-')
        ? 'No text changes were measured; binary changes are ignored.'
        : null
  };
}

function scanMarkdownDrift(
  scanRoot,
  repositoryRoot,
  trackedPaths,
  indexPaths = trackedPaths,
  watchedPaths = trackedPaths
) {
  return watchedPaths
    .filter(isMarkdownPath)
    .sort(comparePaths)
    .map(watchedPath => calculateDrift(scanRoot, repositoryRoot, watchedPath, trackedPaths, indexPaths));
}

module.exports = {
  isMarkdownPath,
  directoryFor,
  isRelatedTo,
  isTextBuffer,
  isTextEntry,
  countTextLines,
  safelyReadRelatedFile,
  countCurrentTextLines,
  sumTextChanges,
  calculateDrift,
  scanMarkdownDrift
};
