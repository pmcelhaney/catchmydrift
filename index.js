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
  calculateDriftForRelatedPaths,
  calculateDrift,
  hasSafeWorkingTreeEntry,
  countCurrentTextLines,
  countTextLines,
  isTextBuffer,
  isMarkdownPath,
  isRelatedTo,
  sumTextChanges
} = require('./lib/drift');
const {
  ConfigError,
  resolveConfigPath,
  resolveConfiguredWatch
} = require('./lib/config');

const USAGE = `Usage: catchmydrift [check] [root] [options]

Check watched Git-tracked files for drift against their related tracked files.

Without configuration, every Git-tracked lowercase .md file is watched and
related to the Git-tracked files in its directory subtree.

Options:
  --threshold <0-100>  Percent drift allowed before a check fails (default: 0)
  --config <path>      Read configuration from a JSON file inside the scan root
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
  let threshold;
  let config;
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
    if (!endOfOptions && argument === '--config') {
      index += 1;
      if (typeof args[index] !== 'string' || args[index].length === 0) {
        throw new UsageError('--config requires a path.');
      }
      config = args[index];
      continue;
    }
    if (!endOfOptions && argument.startsWith('--config=')) {
      const value = argument.slice('--config='.length);
      if (value.length === 0) {
        throw new UsageError('--config requires a path.');
      }
      config = value;
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

  return { threshold, thresholdProvided: threshold !== undefined, config, root: positionals[0] };
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

  const checkedLabel = `${results.length} watched ${results.length === 1 ? 'file' : 'files'} checked`;
  if (failures === 0) {
    stdout.write(`Healthy: ${checkedLabel}; no watched files exceed the ${formatPercent(threshold)} threshold.\n`);
  } else {
    stdout.write(
      `${checkedLabel}; ${failures} ${failures === 1 ? 'watched file exceeds' : 'watched files exceed'} ` +
      `the ${formatPercent(threshold)} threshold.\n`
    );
  }
}

function writeConfiguredScanOutput(results, scan, stdout) {
  let failures = 0;
  for (const result of results) {
    const watchedPath = displayPath(scan.rootRelative, result.watchedPath);
    if (result.missing) {
      failures += 1;
      stdout.write(`missing: ${watchedPath} (threshold ${formatPercent(result.threshold)})\n`);
      continue;
    }
    if (result.warning) {
      stdout.write(`warning: ${watchedPath}: ${result.warning}\n`);
    }
    if (result.percent > result.threshold) {
      failures += 1;
    }
    stdout.write(`${formatPercent(result.percent)} (threshold ${formatPercent(result.threshold)}) ${watchedPath}\n`);
  }

  const checkedLabel = `${results.length} watched ${results.length === 1 ? 'file' : 'files'} checked`;
  if (failures === 0) {
    stdout.write(`Healthy: ${checkedLabel}; no watched files exceed their effective thresholds.\n`);
  } else {
    const failureDescription = failures === 1
      ? 'watched file is missing or exceeds'
      : 'watched files are missing or exceed';
    const thresholdPossessive = failures === 1 ? 'its' : 'their';
    stdout.write(
      `${checkedLabel}; ${failures} ${failureDescription} ${thresholdPossessive} effective thresholds.\n`
    );
  }
}

function check(root, options = {}) {
  const normalizedOptions = typeof options === 'number' ? { threshold: options, thresholdProvided: true } : options;
  const scan = normalizeScanRoot(root);
  const indexPaths = listIndexFiles(scan.repositoryRoot, scan.rootRelative);
  const trackedPaths = listTrackedFiles(scan.repositoryRoot, scan.rootRelative);
  const loadedConfiguration = resolveConfigPath(scan.scanRoot, normalizedOptions.config, normalizedOptions.cwd || process.cwd());
  if (loadedConfiguration === null) {
    const threshold = normalizedOptions.threshold === undefined ? 0 : normalizedOptions.threshold;
    const results = scanMarkdownDrift(scan.scanRoot, scan.repositoryRoot, trackedPaths, indexPaths);
    return {
      scan,
      indexPaths,
      trackedPaths,
      results,
      threshold,
      configured: false,
      failed: results.some(result => result.percent > threshold)
    };
  }

  const rules = resolveConfiguredWatch(scan, loadedConfiguration.config, trackedPaths);
  const results = [];
  const indexPathSet = new Set(indexPaths);
  for (const rule of rules) {
    const threshold = normalizedOptions.thresholdProvided
      ? normalizedOptions.threshold
      : rule.threshold;
    for (const scanRelativeWatchedPath of rule.watchedPaths) {
      const watchedPath = scan.rootRelative === '.'
        ? scanRelativeWatchedPath
        : `${scan.rootRelative}/${scanRelativeWatchedPath}`;
      if (
        !rule.historicalPaths.has(watchedPath) ||
        !indexPathSet.has(watchedPath) ||
        !hasSafeWorkingTreeEntry(scan.scanRoot, scan.repositoryRoot, watchedPath)
      ) {
        results.push({ watchedPath, missing: true, threshold });
        continue;
      }
      results.push({
        ...calculateDriftForRelatedPaths(
          scan.scanRoot,
          scan.repositoryRoot,
          watchedPath,
          rule.relatedPaths,
          indexPaths
        ),
        threshold,
        missing: false
      });
    }
  }
  results.sort((left, right) => left.watchedPath < right.watchedPath ? -1 : left.watchedPath > right.watchedPath ? 1 : 0);
  return {
    scan,
    indexPaths,
    trackedPaths,
    results,
    configuration: loadedConfiguration,
    configured: true,
    failed: results.some(result => result.missing || result.percent > result.threshold)
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
    const result = check(root, {
      threshold: parsed.threshold,
      thresholdProvided: parsed.thresholdProvided,
      config: parsed.config,
      cwd
    });
    if (result.configured) {
      writeConfiguredScanOutput(result.results, result.scan, stdout);
    } else {
      writeScanOutput(result.results, result.scan, result.threshold, stdout);
    }
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
  writeConfiguredScanOutput,
  check,
  main,
  OperationalError,
  normalizeScanRoot,
  listIndexFiles,
  listTrackedFiles,
  scanMarkdownDrift,
  calculateDriftForRelatedPaths,
  calculateDrift,
  hasSafeWorkingTreeEntry,
  countTextLines,
  isTextBuffer,
  isMarkdownPath,
  isRelatedTo,
  sumTextChanges,
  runGit,
  baselineForPath,
  diffNumstat,
  diffAttributesForPaths,
  EMPTY_TREE_HASH,
  ConfigError,
  resolveConfigPath,
  resolveConfiguredWatch
};
