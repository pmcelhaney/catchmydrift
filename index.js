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
  isWithin,
  isStatePath,
  listTreeEntries,
  selectNewerCommit,
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
  sumTextChanges,
  defaultRelationshipDefinition,
  matchesDefaultRelationship
} = require('./lib/drift');
const {
  ConfigError,
  resolveConfigPath,
  resolveConfiguredWatch,
  relationshipSignature,
  matchesConfiguredRelationship,
  scanRelativePath
} = require('./lib/config');
const {
  STATE_FILENAME,
  StateHealthError,
  loadState,
  createReviewEntry,
  writeStateAtomically,
  findTokenCommit,
  verifyPendingSnapshot,
  verifyCommittedSnapshot
} = require('./lib/review-state');

const USAGE = `Usage: catchmydrift [check] [root] [options]
       catchmydrift review <file...> [--root <root>] [--config <path>]

Check watched Git-tracked files for drift against their related tracked files.

Without configuration, every Git-tracked lowercase .md file is watched and
related to the Git-tracked files in its directory subtree.

Options:
  --threshold <0-100>  Percent drift allowed before a check fails (default: 20)
  --root <root>         Select the scan root for review (default: current directory)
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
  if (args[0] === 'review') {
    return parseReviewArguments(args.slice(1));
  }
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

  return { command: 'check', threshold, thresholdProvided: threshold !== undefined, config, root: positionals[0] };
}

function parseReviewArguments(args) {
  const files = [];
  let root;
  let config;
  let endOfOptions = false;
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
    if (!endOfOptions && (argument === '--threshold' || argument.startsWith('--threshold='))) {
      throw new UsageError('--threshold is available only for check.');
    }
    if (!endOfOptions && argument === '--root') {
      index += 1;
      if (typeof args[index] !== 'string' || args[index].length === 0) {
        throw new UsageError('--root requires a path.');
      }
      root = args[index];
      continue;
    }
    if (!endOfOptions && argument.startsWith('--root=')) {
      root = argument.slice('--root='.length);
      if (!root) {
        throw new UsageError('--root requires a path.');
      }
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
      config = argument.slice('--config='.length);
      if (!config) {
        throw new UsageError('--config requires a path.');
      }
      continue;
    }
    if (!endOfOptions && argument.startsWith('-')) {
      throw new UsageError(`Unknown option: ${argument}`);
    }
    files.push(argument);
  }
  if (files.length === 0) {
    throw new UsageError('review requires at least one watched file path.');
  }
  return { command: 'review', files, root, config };
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
  let approvalFailures = 0;
  for (const result of results) {
    const watchedPath = displayPath(scan.rootRelative, result.watchedPath);
    if (result.missing) {
      failures += 1;
      stdout.write(`missing: ${watchedPath} (threshold ${formatPercent(threshold)})\n`);
      continue;
    }
    if (result.warning) {
      stdout.write(`warning: ${watchedPath}: ${result.warning}\n`);
    }
    if (result.approvalFailure) {
      failures += 1;
      approvalFailures += 1;
      stdout.write(`${result.approvalFailure}: ${watchedPath}: ${result.approvalMessage}\n`);
      continue;
    }
    if (result.percent > threshold) {
      failures += 1;
      stdout.write(`${formatPercent(result.percent)} (threshold ${formatPercent(threshold)}) ${watchedPath}\n`);
    }
  }

  const checkedLabel = `${results.length} watched ${results.length === 1 ? 'file' : 'files'} checked`;
  if (failures === 0) {
    stdout.write(`Healthy: ${checkedLabel}; no watched files exceed the ${formatPercent(threshold)} threshold.\n`);
  } else if (approvalFailures > 0) {
    stdout.write(
      `${checkedLabel}; ${failures} ${failures === 1 ? 'watched file failed' : 'watched files failed'} the check.\n`
    );
  } else {
    stdout.write(
      `${checkedLabel}; ${failures} ${failures === 1 ? 'watched file exceeds' : 'watched files exceed'} ` +
      `the ${formatPercent(threshold)} threshold.\n`
    );
  }
}

function writeConfiguredScanOutput(results, scan, stdout) {
  let failures = 0;
  let approvalFailures = 0;
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
    if (result.approvalFailure) {
      failures += 1;
      approvalFailures += 1;
      stdout.write(`${result.approvalFailure}: ${watchedPath}: ${result.approvalMessage}\n`);
      continue;
    }
    if (result.percent > result.threshold) {
      failures += 1;
    }
    stdout.write(`${formatPercent(result.percent)} (threshold ${formatPercent(result.threshold)}) ${watchedPath}\n`);
  }

  const checkedLabel = `${results.length} watched ${results.length === 1 ? 'file' : 'files'} checked`;
  if (failures === 0) {
    stdout.write(`Healthy: ${checkedLabel}; no watched files exceed their effective thresholds.\n`);
  } else if (approvalFailures > 0) {
    stdout.write(
      `${checkedLabel}; ${failures} ${failures === 1 ? 'watched file failed' : 'watched files failed'} the check.\n`
    );
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

function resolveWatchPlan(root, options = {}) {
  const normalizedOptions = typeof options === 'number' ? { threshold: options, thresholdProvided: true } : options;
  const scan = normalizeScanRoot(root);
  const indexPaths = listIndexFiles(scan.repositoryRoot, scan.rootRelative);
  const trackedPaths = listTrackedFiles(scan.repositoryRoot, scan.rootRelative);
  const loadedConfiguration = resolveConfigPath(scan.scanRoot, normalizedOptions.config, normalizedOptions.cwd || process.cwd());
  const loadedState = loadState(scan);
  const indexPathSet = new Set(indexPaths);
  if (loadedConfiguration === null) {
    const threshold = normalizedOptions.threshold === undefined ? 20 : normalizedOptions.threshold;
    return {
      scan,
      indexPaths,
      trackedPaths,
      threshold,
      configured: false,
      loadedState,
      entries: trackedPaths.filter(isMarkdownPath).sort().map(watchedPath => {
        const relationshipDefinition = defaultRelationshipDefinition(watchedPath);
        const relatedPaths = trackedPaths.filter(candidatePath => matchesDefaultRelationship(relationshipDefinition, candidatePath));
        return {
          watchedPath,
          relatedPaths,
          currentRelatedPaths: relatedPaths.filter(candidatePath => indexPathSet.has(candidatePath)),
          threshold,
          currentlyWatched: indexPathSet.has(watchedPath) && hasSafeWorkingTreeEntry(scan.scanRoot, scan.repositoryRoot, watchedPath),
          relationshipDefinition,
          relationship: relationshipSignature(relationshipDefinition),
          matchesRelationship: candidatePath => matchesDefaultRelationship(relationshipDefinition, candidatePath)
        };
      })
    };
  }

  const configuredCandidatePaths = new Set(trackedPaths);
  for (const [watchedPath, reviewEntry] of Object.entries(loadedState.state.reviews)) {
    configuredCandidatePaths.add(watchedPath);
    for (const file of reviewEntry.files) {
      configuredCandidatePaths.add(file.path);
    }
  }
  const rules = resolveConfiguredWatch(
    scan,
    loadedConfiguration.config,
    [...configuredCandidatePaths].sort()
  );
  const entries = [];
  for (const rule of rules) {
    const threshold = normalizedOptions.thresholdProvided
      ? normalizedOptions.threshold
      : rule.threshold;
    for (const scanRelativeWatchedPath of rule.watchedPaths) {
      const watchedPath = scan.rootRelative === '.'
        ? scanRelativeWatchedPath
        : `${scan.rootRelative}/${scanRelativeWatchedPath}`;
      entries.push({
        watchedPath,
        relatedPaths: rule.relatedPaths,
        currentRelatedPaths: rule.relatedPaths.filter(candidatePath => indexPathSet.has(candidatePath)),
        threshold,
        currentlyWatched: rule.historicalPaths.has(watchedPath) &&
          indexPathSet.has(watchedPath) &&
          hasSafeWorkingTreeEntry(scan.scanRoot, scan.repositoryRoot, watchedPath),
        relationshipDefinition: rule.relationshipDefinition,
        relationship: rule.relationship,
        matchesRelationship: candidatePath => matchesConfiguredRelationship(
          rule.relationshipDefinition,
          scanRelativePath(scan.rootRelative, candidatePath)
        )
      });
    }
  }
  entries.sort((left, right) => left.watchedPath < right.watchedPath ? -1 : left.watchedPath > right.watchedPath ? 1 : 0);
  return {
    scan,
    indexPaths,
    trackedPaths,
    entries,
    configuration: loadedConfiguration,
    loadedState,
    configured: true
  };
}

function resultForPlanEntry(plan, planEntry, stateEntry) {
  if (!planEntry.currentlyWatched && plan.configured) {
    return { watchedPath: planEntry.watchedPath, missing: true, threshold: planEntry.threshold };
  }
  let warning = null;
  let baseline;
  if (stateEntry && stateEntry.relationship !== planEntry.relationship) {
    warning = 'The saved review relationship changed; the approval was ignored.';
    stateEntry = null;
  }
  if (stateEntry) {
    let reviewCommit;
    try {
      reviewCommit = findTokenCommit(plan.scan, planEntry.watchedPath, stateEntry);
      if (reviewCommit === null) {
        if (!verifyPendingSnapshot(plan.scan, planEntry, stateEntry)) {
          return {
            watchedPath: planEntry.watchedPath,
            threshold: planEntry.threshold,
            approvalFailure: 'stale approval',
            approvalMessage: 'the reviewed working-tree snapshot has changed'
          };
        }
        return {
          watchedPath: planEntry.watchedPath,
          threshold: planEntry.threshold,
          percent: 0,
          warning: null,
          pendingApproval: true
        };
      }
      if (!verifyCommittedSnapshot(plan.scan, planEntry, stateEntry, reviewCommit)) {
        return {
          watchedPath: planEntry.watchedPath,
          threshold: planEntry.threshold,
          approvalFailure: 'invalid approval',
          approvalMessage: `the saved snapshot does not match review commit ${reviewCommit}`
        };
      }
      const watchedBaseline = baselineForPath(plan.scan.repositoryRoot, planEntry.watchedPath);
      baseline = selectNewerCommit(
        plan.scan.repositoryRoot,
        [reviewCommit, watchedBaseline]
      );
      if (baseline === watchedBaseline && watchedBaseline !== reviewCommit) {
        warning = 'A later watched-file commit superseded the saved review baseline.';
      }
    } catch (error) {
      if (error instanceof StateHealthError) {
        return {
          watchedPath: planEntry.watchedPath,
          threshold: planEntry.threshold,
          approvalFailure: 'invalid approval',
          approvalMessage: error.message
        };
      }
      throw error;
    }
  }
  const effectiveBaseline = baseline || baselineForPath(plan.scan.repositoryRoot, planEntry.watchedPath);
  const baselineRelatedPaths = effectiveBaseline === EMPTY_TREE_HASH
    ? []
    : listTreeEntries(plan.scan.repositoryRoot, effectiveBaseline, plan.scan.rootRelative)
      .map(entry => entry.path)
      .filter(candidatePath => !isStatePath(candidatePath) && planEntry.matchesRelationship(candidatePath));
  const comparisonPaths = [...new Set([...planEntry.relatedPaths, ...baselineRelatedPaths])].sort();
  const drift = calculateDriftForRelatedPaths(
    plan.scan.scanRoot,
    plan.scan.repositoryRoot,
    planEntry.watchedPath,
    comparisonPaths,
    plan.indexPaths,
    { baseline: effectiveBaseline }
  );
  return {
    ...drift,
    threshold: planEntry.threshold,
    missing: false,
    warning: warning || drift.warning
  };
}

function check(root, options = {}) {
  const plan = resolveWatchPlan(root, options);
  const results = plan.entries.map(entry => resultForPlanEntry(
    plan,
    entry,
    plan.loadedState.state.reviews[entry.watchedPath]
  ));
  return {
    ...plan,
    results,
    failed: results.some(result => result.missing || result.approvalFailure || result.percent > result.threshold)
  };
}

function normalizeReviewTarget(scan, target) {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    throw new UsageError('Review file paths must be non-empty paths.');
  }
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(scan.scanRoot, target);
  if (!isWithin(scan.scanRoot, absolute)) {
    throw new UsageError(`Review path is outside the selected scan root: ${target}`);
  }
  const relative = path.relative(scan.repositoryRoot, absolute).split(path.sep).join('/');
  if (!relative || relative === '.' || relative.endsWith('/')) {
    throw new UsageError(`Review target must be a file: ${target}`);
  }
  return relative;
}

function review(root, targets, options = {}) {
  const plan = resolveWatchPlan(root, options);
  const byPath = new Map(plan.entries.map(entry => [entry.watchedPath, entry]));
  const selected = [];
  const seen = new Set();
  for (const target of targets) {
    const watchedPath = normalizeReviewTarget(plan.scan, target);
    if (seen.has(watchedPath)) {
      throw new UsageError(`Review target was provided more than once: ${target}`);
    }
    seen.add(watchedPath);
    const entry = byPath.get(watchedPath);
    if (!entry) {
      throw new UsageError(`Path is not currently watched: ${target}`);
    }
    if (!entry.currentlyWatched) {
      throw new UsageError(`Watched path is missing or unsafe: ${target}`);
    }
    selected.push(entry);
  }
  const reviews = Object.assign(Object.create(null), plan.loadedState.state.reviews);
  for (const entry of selected) {
    reviews[entry.watchedPath] = createReviewEntry(plan.scan, entry);
  }
  const state = { version: 1, reviews };
  writeStateAtomically(plan.scan, state);
  return { scan: plan.scan, watchedPaths: selected.map(entry => entry.watchedPath).sort(), statePath: STATE_FILENAME };
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
    if (parsed.command === 'review') {
      const result = review(root, parsed.files, { config: parsed.config, cwd });
      for (const watchedPath of result.watchedPaths) {
        stdout.write(`Approved: ${displayPath(result.scan.rootRelative, watchedPath)}\n`);
      }
      stdout.write(`Commit ${STATE_FILENAME} with the reviewed changes to make this approval persistent.\n`);
      return 0;
    }
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
    } else if (error instanceof StateHealthError) {
      stderr.write(`catchmydrift: unhealthy review state: ${error.message}\n`);
      return 1;
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
  parseReviewArguments,
  displayPath,
  formatPercent,
  writeScanOutput,
  writeConfiguredScanOutput,
  resolveWatchPlan,
  check,
  review,
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
