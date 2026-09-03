#!/usr/bin/env node

'use strict';

const path = require('node:path');
const packageJson = require('./package.json');
const {
  OperationalError,
  normalizeScanRoot,
  listIndexFiles,
  listTrackedFiles,
  runGit,
  baselineForPath,
  diffNumstat,
  diffAttributesForPaths,
  EMPTY_TREE_HASH
} = require('./lib/git');
const {
  scanMarkdownDrift,
  calculateDrift,
  countCurrentTextLines,
  countTextLines,
  isTextBuffer,
  isMarkdownPath,
  isRelatedTo,
  sumTextChanges
} = require('./lib/drift');

const USAGE = `Usage: catchmydrift [check] [root] [options]

Check Git-tracked Markdown files for drift against the tracked files below them.

Options:
  --threshold <0-100>  Percent drift allowed before a check fails (default: 0)
  --help               Show this help message
  --version            Show the installed version`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function parseThreshold(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('--threshold requires a finite number from 0 through 100.');
  }
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new UsageError('--threshold must be a finite number from 0 through 100.');
  }
  return threshold;
}

function parseArguments(args) {
  const positionals = [];
  let threshold = 0;
  let endOfOptions = false;
  let commandSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!endOfOptions && argument === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (argument === '--help' || argument === '-h')) {
      return { help: true };
    }
    if (!endOfOptions && (argument === '--version' || argument === '-V')) {
      return { version: true };
    }
    if (!endOfOptions && argument === '--threshold') {
      index += 1;
      threshold = parseThreshold(args[index]);
      continue;
    }
    if (!endOfOptions && argument.startsWith('--threshold=')) {
      threshold = parseThreshold(argument.slice('--threshold='.length));
      continue;
    }
    if (!endOfOptions && argument.startsWith('-')) {
      throw new UsageError(`Unknown option: ${argument}`);
    }
    if (!endOfOptions && !commandSeen && positionals.length === 0 && argument === 'check') {
      commandSeen = true;
      continue;
    }
    positionals.push(argument);
  }
  if (positionals.length > 1) {
    throw new UsageError('Expected at most one scan root.');
  }

  return { threshold, root: positionals[0] };
}

function displayPath(rootRelative, watchedPath) {
  if (rootRelative === '.') {
    return watchedPath;
  }
  const prefix = `${rootRelative}/`;
  if (!watchedPath.startsWith(prefix)) {
    throw new OperationalError(`Git returned a path outside the selected scan root: ${watchedPath}`);
  }
  return watchedPath.slice(prefix.length);
}

function formatPercent(percent) {
  return `${percent.toFixed(2)}%`;
}

function writeScanOutput(results, scan, threshold, stdout) {
  let failures = 0;
  for (const result of results) {
    const watchedPath = displayPath(scan.rootRelative, result.watchedPath);
    if (result.warning) {
      stdout.write(`warning: ${watchedPath}: ${result.warning}\n`);
    }
    if (result.percent > threshold) {
      failures += 1;
      stdout.write(`${formatPercent(result.percent)} (threshold ${formatPercent(threshold)}) ${watchedPath}\n`);
    }
  }

  const checkedLabel = `${results.length} Markdown ${results.length === 1 ? 'file' : 'files'} checked`;
  if (failures === 0) {
    stdout.write(`Healthy: ${checkedLabel}; no documents exceed the ${formatPercent(threshold)} threshold.\n`);
  } else {
    stdout.write(
      `${checkedLabel}; ${failures} ${failures === 1 ? 'outdated document exceeds' : 'outdated documents exceed'} ` +
      `the ${formatPercent(threshold)} threshold.\n`
    );
  }
}

function check(root, threshold) {
  const scan = normalizeScanRoot(root);
  const indexPaths = listIndexFiles(scan.repositoryRoot, scan.rootRelative);
  const trackedPaths = listTrackedFiles(scan.repositoryRoot, scan.rootRelative);
  const results = scanMarkdownDrift(scan.scanRoot, scan.repositoryRoot, trackedPaths, indexPaths);
  return {
    scan,
    indexPaths,
    trackedPaths,
    results,
    failed: results.some(result => result.percent > threshold)
  };
}

function main(args = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const cwd = options.cwd || process.cwd();

  try {
    const parsed = parseArguments(args);
    if (parsed.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (parsed.version) {
      stdout.write(`${packageJson.version}\n`);
      return 0;
    }

    const root = parsed.root ? path.resolve(cwd, parsed.root) : cwd;
    const result = check(root, parsed.threshold);
    writeScanOutput(result.results, result.scan, parsed.threshold, stdout);
    return result.failed ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`catchmydrift: ${error.message}\n${USAGE}\n`);
    } else if (error instanceof OperationalError) {
      stderr.write(`catchmydrift: ${error.message}\n`);
    } else {
      stderr.write(`catchmydrift: ${error.message || 'Unexpected failure.'}\n`);
    }
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  USAGE,
  UsageError,
  parseThreshold,
  parseArguments,
  displayPath,
  formatPercent,
  writeScanOutput,
  check,
  main,
  OperationalError,
  normalizeScanRoot,
  listIndexFiles,
  listTrackedFiles,
  scanMarkdownDrift,
  calculateDrift,
  countTextLines,
  isTextBuffer,
  isMarkdownPath,
  isRelatedTo,
  sumTextChanges,
  runGit,
  baselineForPath,
  diffNumstat,
  diffAttributesForPaths,
  EMPTY_TREE_HASH
};
