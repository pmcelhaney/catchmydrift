/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 422:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const os = __nccwpck_require__(161);
const path = __nccwpck_require__(760);
const { randomUUID } = __nccwpck_require__(598);
const { check, parseThreshold } = __nccwpck_require__(136);
const { normalizeScanRoot, runGit, isWithin } = __nccwpck_require__(412);

function input(name) {
  return (process.env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] || '').trim();
}
function setOutput(name, value) {
  // File commands support multiline paths without interpreting them as commands.
  let delimiter;
  do { delimiter = `catchmydrift_${randomUUID()}`; } while (value.includes(delimiter));
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
function setFailed(message) {
  console.error(message);
  process.exitCode = 1;
}
function bool(name, fallback = false) {
  const value = input(name);
  if (!value) return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`Input ${name} must be true or false.`);
  return value === 'true';
}
function run() {
  const root = path.resolve(process.env.GITHUB_WORKSPACE || '.', input('root') || '.');
  const workspace = fs.realpathSync(process.env.GITHUB_WORKSPACE || '.');
  if (!isWithin(workspace, fs.realpathSync(root))) throw new Error('root must stay within GITHUB_WORKSPACE.');
  const { repositoryRoot } = normalizeScanRoot(root);
  if (runGit(['rev-parse', '--is-shallow-repository'], repositoryRoot).stdout.toString('utf8').trim() === 'true') {
    setFailed('Catch My Drift requires full Git history. Set fetch-depth: 0 on actions/checkout and rerun the job.');
    return;
  }
  const threshold = input('threshold');
  const scan = check(root, { config: input('config') || undefined, cwd: workspace,
    ...(threshold ? { threshold: parseThreshold(threshold), thresholdProvided: true } : {}) });
  const report = { driftDetected: scan.failed, results: scan.results.map(({ watchedPath, baseline, percent, threshold, missing }) =>
      ({ watchedPath, baseline, percent: Number.isFinite(percent) ? percent : null, threshold, missing: !!missing })) };
  const output = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'catchmydrift-'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  setOutput('report-directory', output);
  setOutput('drift-detected', String(scan.failed));
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Catch My Drift\n\nDrift detected: ${scan.failed}.\n\nSee report.json in the report artifact for results.\n`);
  if (bool('fail-on-drift') && scan.failed) setFailed('Documentation drift exceeds the configured threshold.');
}
if (require.main === require.cache[eval('__filename')]) {
  try { run(); } catch {
    setFailed('Catch My Drift could not analyze this checkout. Check inputs, full Git history, and configuration; see the README for setup instructions.');
  }
}
module.exports = { run };


/***/ }),

/***/ 136:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {




const path = __nccwpck_require__(760);
const packageJson = __nccwpck_require__(330);
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
} = __nccwpck_require__(412);
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
} = __nccwpck_require__(295);
const {
  ConfigError,
  resolveConfigPath,
  resolveConfiguredWatch,
  matchesConfiguredRelationship,
  scanRelativePath
} = __nccwpck_require__(472);
const {
  STATE_FILENAME,
  StateHealthError,
  loadState,
  writeStateAtomically
} = __nccwpck_require__(246);

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
          matchesRelationship: candidatePath => matchesDefaultRelationship(relationshipDefinition, candidatePath)
        };
      })
    };
  }

  const configuredCandidatePaths = new Set(trackedPaths);
  for (const watchedPath of Object.keys(loadedState.state)) {
    configuredCandidatePaths.add(watchedPath);
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
  const watchedBaseline = baselineForPath(plan.scan.repositoryRoot, planEntry.watchedPath);
  const effectiveBaseline = stateEntry
    ? selectNewerCommit(plan.scan.repositoryRoot, [stateEntry, watchedBaseline])
    : watchedBaseline;
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
    warning: drift.warning
  };
}

function check(root, options = {}) {
  const plan = resolveWatchPlan(root, options);
  const results = plan.entries.map(entry => resultForPlanEntry(
    plan,
    entry,
    plan.loadedState.state[entry.watchedPath]
  ));
  return {
    ...plan,
    results,
    failed: results.some(result => result.missing || result.percent > result.threshold)
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
  const head = runGit(['rev-parse', '--verify', 'HEAD'], plan.scan.repositoryRoot, { allowFailure: true });
  if (head.status !== 0) {
    throw new UsageError('Review requires a committed HEAD. Commit the watched and related files first.');
  }
  const commit = head.stdout.toString('utf8').trim();
  const paths = new Set(selected.flatMap(entry => [entry.watchedPath, ...entry.relatedPaths]));
  for (const treeEntry of listTreeEntries(plan.scan.repositoryRoot, commit, plan.scan.rootRelative)) {
    if (!isStatePath(treeEntry.path) && selected.some(entry => entry.matchesRelationship(treeEntry.path))) {
      paths.add(treeEntry.path);
    }
  }
  const status = runGit([
    '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no',
    '--ignore-submodules=none', '--', ...[...paths].sort()
  ], plan.scan.repositoryRoot);
  if (status.stdout.length > 0) {
    throw new UsageError('Review requires committed watched and related content. Commit staged and unstaged changes first.');
  }
  const state = Object.assign(Object.create(null), plan.loadedState.state);
  for (const entry of selected) {
    state[entry.watchedPath] = commit;
  }
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
      stdout.write(`Commit ${STATE_FILENAME} to share these review baselines with the repository.\n`);
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

if (false) {}

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


/***/ }),

/***/ 472:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const path = __nccwpck_require__(760);
const { Minimatch, unescape } = __nccwpck_require__(507);
const {
  OperationalError,
  comparePaths,
  isStatePath,
  isWithin
} = __nccwpck_require__(412);

const DEFAULT_CONFIG_FILENAME = 'catchmydrift.config.json';
const MATCH_OPTIONS = Object.freeze({ dot: true, nocomment: true, nonegate: true });

class ConfigError extends OperationalError {
  constructor(message, cause) {
    super(message, cause);
    this.name = 'ConfigError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertKnownKeys(value, keys, location) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new ConfigError(`${location} contains an unsupported property: ${key}`);
    }
  }
}

function validateThreshold(value, location) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConfigError(`${location} must be a finite number from 0 through 100.`);
  }
  return value;
}

function validatePattern(value, location) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${location} must be a non-empty root-relative POSIX glob.`);
  }
  if (
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split('/').includes('..')
  ) {
    throw new ConfigError(`${location} must not be absolute or escape the scan root.`);
  }
  return value;
}

function validatePatternList(value, location, required) {
  if (value === undefined && !required) {
    return [];
  }
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new ConfigError(`${location} must be a ${required ? 'non-empty ' : ''}array of root-relative POSIX globs.`);
  }
  return value.map((pattern, index) => validatePattern(pattern, `${location}[${index}]`));
}

function normalizeConfig(value) {
  if (!isPlainObject(value)) {
    throw new ConfigError('Configuration must be a JSON object.');
  }
  assertKnownKeys(value, new Set(['$schema', 'threshold', 'groups', 'watch']), 'Configuration');

  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    throw new ConfigError('Configuration $schema must be a string.');
  }
  const threshold = value.threshold === undefined ? 20 : validateThreshold(value.threshold, 'Configuration threshold');
  const rawGroups = value.groups;
  if (!isPlainObject(rawGroups) || Object.keys(rawGroups).length === 0) {
    throw new ConfigError('Configuration groups must be a non-empty object.');
  }

  const groups = Object.create(null);
  for (const groupName of Object.keys(rawGroups).sort(comparePaths)) {
    if (groupName.length === 0 || !isPlainObject(rawGroups[groupName])) {
      throw new ConfigError(`Configuration group ${JSON.stringify(groupName)} must be an object with a non-empty include list.`);
    }
    const group = rawGroups[groupName];
    assertKnownKeys(group, new Set(['include', 'exclude']), `Configuration group ${JSON.stringify(groupName)}`);
    groups[groupName] = {
      include: validatePatternList(group.include, `Configuration group ${JSON.stringify(groupName)} include`, true),
      exclude: validatePatternList(group.exclude, `Configuration group ${JSON.stringify(groupName)} exclude`, false)
    };
  }

  const rawWatch = value.watch;
  if (!Array.isArray(rawWatch) || rawWatch.length === 0) {
    throw new ConfigError('Configuration watch must be a non-empty array.');
  }
  const watch = rawWatch.map((rule, index) => {
    const location = `Configuration watch[${index}]`;
    if (!isPlainObject(rule)) {
      throw new ConfigError(`${location} must be an object.`);
    }
    assertKnownKeys(rule, new Set(['include', 'exclude', 'groups', 'threshold']), location);
    if (!Array.isArray(rule.groups) || rule.groups.length === 0 || rule.groups.some(groupName => typeof groupName !== 'string' || groupName.length === 0)) {
      throw new ConfigError(`${location} groups must be a non-empty array of group names.`);
    }
    for (const groupName of rule.groups) {
      if (!Object.hasOwn(groups, groupName)) {
        throw new ConfigError(`${location} references an unknown group: ${groupName}`);
      }
    }
    if (new Set(rule.groups).size !== rule.groups.length) {
      throw new ConfigError(`${location} groups must not contain duplicate group names.`);
    }
    return {
      include: validatePatternList(rule.include, `${location} include`, true),
      exclude: validatePatternList(rule.exclude, `${location} exclude`, false),
      groups: rule.groups,
      threshold: rule.threshold === undefined ? undefined : validateThreshold(rule.threshold, `${location} threshold`)
    };
  });

  return { threshold, groups, watch };
}

function resolveConfigPath(scanRoot, requestedConfigPath, cwd) {
  const defaulted = requestedConfigPath === undefined;
  const candidate = defaulted
    ? path.join(scanRoot, DEFAULT_CONFIG_FILENAME)
    : path.resolve(cwd, requestedConfigPath);
  if (!isWithin(scanRoot, candidate)) {
    throw new ConfigError(`Configuration path must remain inside the selected scan root: ${candidate}`);
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' && defaulted) {
      return null;
    }
    if (error.code === 'ENOENT') {
      throw new ConfigError(`Configuration file does not exist: ${candidate}`, error);
    }
    throw new ConfigError(`Unable to resolve configuration file: ${candidate}`, error);
  }
  if (!isWithin(scanRoot, realPath)) {
    throw new ConfigError(`Configuration path must remain inside the selected scan root: ${candidate}`);
  }
  let contents;
  try {
    contents = fs.readFileSync(realPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Unable to read configuration file: ${candidate}`, error);
  }
  try {
    return { path: realPath, config: normalizeConfig(JSON.parse(contents)) };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Configuration file contains invalid JSON: ${candidate}`, error);
  }
}

function createMatcher(pattern) {
  return new Minimatch(pattern, MATCH_OPTIONS);
}

function scanRelativePath(rootRelative, repositoryPath) {
  if (rootRelative === '.') {
    return repositoryPath;
  }
  const prefix = `${rootRelative}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new ConfigError(`Git returned a path outside the selected scan root: ${repositoryPath}`);
  }
  return repositoryPath.slice(prefix.length);
}

function repositoryRelativePath(rootRelative, relativePath) {
  return rootRelative === '.' ? relativePath : `${rootRelative}/${relativePath}`;
}

function matchesPattern(matcher, candidatePaths) {
  return candidatePaths.filter(candidatePath => matcher.match(candidatePath));
}

function excludesPath(excludeMatchers, candidatePath) {
  return excludeMatchers.some(matcher => matcher.match(candidatePath));
}

function sortedUnique(values) {
  return [...new Set(values)].sort(comparePaths);
}

function configuredRelationshipDefinition(configuration, rule) {
  const groupDefinitions = rule.groups.map(groupName => {
    const group = configuration.groups[groupName];
    return {
      include: sortedUnique(group.include),
      exclude: sortedUnique(group.exclude)
    };
  });
  const groups = [...new Map(
    groupDefinitions.map(group => [JSON.stringify(group), group])
  ).values()];
  groups.sort((left, right) => comparePaths(JSON.stringify(left), JSON.stringify(right)));
  return { kind: 'configured-groups', groups };
}

function matchesConfiguredRelationship(definition, candidatePath) {
  return definition.groups.some(group => {
    const included = group.include.some(pattern => createMatcher(pattern).match(candidatePath));
    return included && !group.exclude.some(pattern => createMatcher(pattern).match(candidatePath));
  });
}

function matchIncludeExclude(include, exclude, candidatePaths) {
  const excludeMatchers = exclude.map(createMatcher);
  const matched = new Set();
  for (const pattern of include) {
    const matcher = createMatcher(pattern);
    for (const candidatePath of matchesPattern(matcher, candidatePaths)) {
      if (!excludesPath(excludeMatchers, candidatePath)) {
        matched.add(candidatePath);
      }
    }
  }
  return [...matched].sort(comparePaths);
}

function literalPathForPattern(pattern) {
  const matcher = createMatcher(pattern);
  if (matcher.hasMagic()) {
    return null;
  }
  return unescape(pattern);
}

function assertWildcardPatternsResolve(include, candidatePaths, location) {
  for (const pattern of include) {
    const matcher = createMatcher(pattern);
    if (matcher.hasMagic() && matchesPattern(matcher, candidatePaths).length === 0) {
      throw new ConfigError(`${location} wildcard include pattern does not match a historical tracked path: ${pattern}`);
    }
  }
}

function isStateLiteral(relativePath) {
  return isStatePath(relativePath);
}

function resolveConfiguredWatch(scan, configuration, trackedPaths) {
  const candidatePaths = trackedPaths.map(repositoryPath => scanRelativePath(scan.rootRelative, repositoryPath));
  const groupPaths = new Map();

  for (const [groupName, group] of Object.entries(configuration.groups)) {
    assertWildcardPatternsResolve(group.include, candidatePaths, `Configuration group ${JSON.stringify(groupName)}`);
    const matches = matchIncludeExclude(group.include, group.exclude, candidatePaths);
    if (matches.length === 0) {
      throw new ConfigError(`Configuration group ${JSON.stringify(groupName)} does not resolve to a historical tracked path.`);
    }
    groupPaths.set(groupName, matches);
  }

  const owners = new Map();
  const rules = [];
  for (const [ruleIndex, rule] of configuration.watch.entries()) {
    assertWildcardPatternsResolve(rule.include, candidatePaths, `Configuration watch[${ruleIndex}]`);
    const matchedPaths = matchIncludeExclude(rule.include, rule.exclude, candidatePaths);
    const excludeMatchers = rule.exclude.map(createMatcher);
    const missingPaths = new Set();
    for (const pattern of rule.include) {
      const literalPath = literalPathForPattern(pattern);
      if (literalPath === null) {
        continue;
      }
      if (isStateLiteral(literalPath)) {
        throw new ConfigError(`Configuration watch[${ruleIndex}] must not watch .catchmydrift-state.json.`);
      }
      if (!candidatePaths.includes(literalPath) && !excludesPath(excludeMatchers, literalPath)) {
        missingPaths.add(literalPath);
      }
    }
    const watchedPaths = [...matchedPaths, ...missingPaths].sort(comparePaths);
    if (watchedPaths.length === 0) {
      throw new ConfigError(`Configuration watch[${ruleIndex}] does not resolve to an effective watched path.`);
    }
    for (const watchedPath of watchedPaths) {
      const priorOwner = owners.get(watchedPath);
      if (priorOwner !== undefined && priorOwner !== ruleIndex) {
        throw new ConfigError(`Configuration watch rules overlap for path: ${watchedPath}`);
      }
      owners.set(watchedPath, ruleIndex);
    }
    const relatedPaths = new Set();
    for (const groupName of rule.groups) {
      for (const relatedPath of groupPaths.get(groupName)) {
        relatedPaths.add(repositoryRelativePath(scan.rootRelative, relatedPath));
      }
    }
    const relationshipDefinition = configuredRelationshipDefinition(configuration, rule);
    rules.push({
      index: ruleIndex,
      watchedPaths,
      relatedPaths: [...relatedPaths].sort(comparePaths),
      threshold: rule.threshold === undefined ? configuration.threshold : rule.threshold,
      historicalPaths: new Set(matchedPaths.map(watchedPath => repositoryRelativePath(scan.rootRelative, watchedPath))),
      relationshipDefinition
    });
  }

  return rules;
}

module.exports = {
  DEFAULT_CONFIG_FILENAME,
  MATCH_OPTIONS,
  ConfigError,
  isPlainObject,
  validateThreshold,
  validatePattern,
  validatePatternList,
  normalizeConfig,
  resolveConfigPath,
  createMatcher,
  scanRelativePath,
  repositoryRelativePath,
  matchIncludeExclude,
  sortedUnique,
  configuredRelationshipDefinition,
  matchesConfiguredRelationship,
  literalPathForPattern,
  assertWildcardPatternsResolve,
  resolveConfiguredWatch
};


/***/ }),

/***/ 295:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const path = __nccwpck_require__(760);
const {
  OperationalError,
  baselineForPath,
  diffNumstat,
  diffAttributesForPaths,
  comparePaths
} = __nccwpck_require__(412);

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

function hasSafeWorkingTreeEntry(scanRoot, repositoryRoot, relativePath) {
  try {
    return safelyReadRelatedFile(scanRoot, repositoryRoot, relativePath) !== null;
  } catch (error) {
    if (error instanceof OperationalError) {
      return false;
    }
    throw error;
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

function calculateDriftForRelatedPaths(
  scanRoot,
  repositoryRoot,
  watchedPath,
  relatedPaths,
  indexPaths = relatedPaths,
  options = {}
) {
  const indexPathSet = indexPaths instanceof Set ? indexPaths : new Set(indexPaths);
  const currentRelatedPaths = relatedPaths.filter(relatedPath => indexPathSet.has(relatedPath));
  const historicalOnlyPaths = relatedPaths.filter(relatedPath => !indexPathSet.has(relatedPath));
  const baseline = options.baseline || baselineForPath(repositoryRoot, watchedPath);
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
      ? 'No measurable current text lines are related to this watched file.'
      : numstat.length > 0 && numstat.every(entry => entry.inserted === '-' || entry.deleted === '-')
        ? 'No text changes were measured; binary changes are ignored.'
        : null
  };
}

function defaultRelationshipDefinition(watchedPath) {
  return { kind: 'default-subtree', directory: directoryFor(watchedPath) };
}

function matchesDefaultRelationship(definition, candidatePath) {
  return definition.directory === '' || candidatePath.startsWith(`${definition.directory}/`);
}

function calculateDrift(scanRoot, repositoryRoot, watchedPath, trackedPaths, indexPaths = trackedPaths) {
  const relatedPaths = trackedPaths.filter(candidatePath => isRelatedTo(watchedPath, candidatePath));
  return calculateDriftForRelatedPaths(scanRoot, repositoryRoot, watchedPath, relatedPaths, indexPaths);
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
  hasSafeWorkingTreeEntry,
  countCurrentTextLines,
  sumTextChanges,
  calculateDriftForRelatedPaths,
  defaultRelationshipDefinition,
  matchesDefaultRelationship,
  calculateDrift,
  scanMarkdownDrift
};


/***/ }),

/***/ 412:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const childProcess = __nccwpck_require__(421);
const fs = __nccwpck_require__(24);
const path = __nccwpck_require__(760);

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
    const stdout = childProcess.execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      encoding: 'buffer',
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      input: options.input,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: 30000,
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

function parseTreeRecord(record) {
  const tab = record.indexOf('\t');
  const header = tab === -1 ? '' : record.slice(0, tab);
  const relativePath = tab === -1 ? '' : record.slice(tab + 1);
  const fields = header.split(' ');
  if (fields.length !== 3 || !relativePath || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(fields[2])) {
    throw new OperationalError('Git returned an invalid tree record.');
  }
  return { mode: fields[0], type: fields[1], objectId: fields[2], path: relativePath };
}

function listTreeEntries(repositoryRoot, commit, rootRelative = '.') {
  const result = runGit(
    ['ls-tree', '-r', '-z', commit, '--', rootRelative],
    repositoryRoot
  );
  return splitNullDelimited(result.stdout).map(parseTreeRecord).sort((left, right) => comparePaths(left.path, right.path));
}

function selectNewerCommit(repositoryRoot, commits) {
  const candidates = [...new Set(commits.filter(commit => commit && commit !== EMPTY_TREE_HASH))];
  if (candidates.length === 0) {
    return EMPTY_TREE_HASH;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const candidateSet = new Set(candidates);
  if (!hasHead(repositoryRoot)) {
    throw new OperationalError('Cannot order baseline commits without HEAD.');
  }
  const history = runGit(['rev-list', '--topo-order', 'HEAD'], repositoryRoot)
    .stdout.toString('utf8').split('\n').filter(Boolean);
  for (const commit of history) {
    if (candidateSet.has(commit)) {
      return commit;
    }
  }
  throw new OperationalError('A candidate baseline commit is not reachable from HEAD.');
}

function diffNumstat(repositoryRoot, baseline, relativePaths, options = {}) {
  if (relativePaths.length === 0) {
    return [];
  }

  const args = ['diff', '--no-ext-diff', '--no-textconv'];
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
  listTreeEntries,
  selectNewerCommit,
  diffNumstat,
  diffAttributesForPaths,
  isStatePath,
  comparePaths
};


/***/ }),

/***/ 246:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const crypto = __nccwpck_require__(598);
const fs = __nccwpck_require__(24);
const path = __nccwpck_require__(760);
const { OperationalError, comparePaths, isStatePath, runGit } = __nccwpck_require__(412);

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


/***/ }),

/***/ 421:
/***/ ((module) => {

module.exports = require("node:child_process");

/***/ }),

/***/ 598:
/***/ ((module) => {

module.exports = require("node:crypto");

/***/ }),

/***/ 24:
/***/ ((module) => {

module.exports = require("node:fs");

/***/ }),

/***/ 161:
/***/ ((module) => {

module.exports = require("node:os");

/***/ }),

/***/ 760:
/***/ ((module) => {

module.exports = require("node:path");

/***/ }),

/***/ 649:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.range = exports.balanced = void 0;
const balanced = (a, b, str) => {
    const ma = a instanceof RegExp ? maybeMatch(a, str) : a;
    const mb = b instanceof RegExp ? maybeMatch(b, str) : b;
    const r = ma !== null && mb != null && (0, exports.range)(ma, mb, str);
    return (r && {
        start: r[0],
        end: r[1],
        pre: str.slice(0, r[0]),
        body: str.slice(r[0] + ma.length, r[1]),
        post: str.slice(r[1] + mb.length),
    });
};
exports.balanced = balanced;
const maybeMatch = (reg, str) => {
    const m = str.match(reg);
    return m ? m[0] : null;
};
const range = (a, b, str) => {
    let begs, beg, left, right = undefined, result;
    let ai = str.indexOf(a);
    let bi = str.indexOf(b, ai + 1);
    let i = ai;
    if (ai >= 0 && bi > 0) {
        if (a === b) {
            return [ai, bi];
        }
        begs = [];
        left = str.length;
        while (i >= 0 && !result) {
            if (i === ai) {
                begs.push(i);
                ai = str.indexOf(a, i + 1);
            }
            else if (begs.length === 1) {
                const r = begs.pop();
                if (r !== undefined)
                    result = [r, bi];
            }
            else {
                beg = begs.pop();
                if (beg !== undefined && beg < left) {
                    left = beg;
                    right = bi;
                }
                bi = str.indexOf(b, i + 1);
            }
            i = ai < bi && ai >= 0 ? ai : bi;
        }
        if (begs.length && right !== undefined) {
            result = [left, right];
        }
    }
    return result;
};
exports.range = range;
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 968:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.EXPANSION_MAX_REWRITES = exports.EXPANSION_MAX_DEPTH = exports.EXPANSION_MAX_LENGTH = exports.EXPANSION_MAX = void 0;
exports.expand = expand;
const balanced_match_1 = __nccwpck_require__(649);
const escSlash = '\0SLASH' + Math.random() + '\0';
const escOpen = '\0OPEN' + Math.random() + '\0';
const escClose = '\0CLOSE' + Math.random() + '\0';
const escComma = '\0COMMA' + Math.random() + '\0';
const escPeriod = '\0PERIOD' + Math.random() + '\0';
const escSlashPattern = new RegExp(escSlash, 'g');
const escOpenPattern = new RegExp(escOpen, 'g');
const escClosePattern = new RegExp(escClose, 'g');
const escCommaPattern = new RegExp(escComma, 'g');
const escPeriodPattern = new RegExp(escPeriod, 'g');
const slashPattern = /\\\\/g;
const openPattern = /\\{/g;
const closePattern = /\\}/g;
const commaPattern = /\\,/g;
const periodPattern = /\\\./g;
exports.EXPANSION_MAX = 100_000;
// `EXPANSION_MAX` caps the *number* of expansions, but not their length. An
// input like `'{a,b}'.repeat(1500)` stays under that count - its output is
// truncated to 100k results - while making every result ~1500 characters
// long. The result set, and the intermediate arrays built while combining
// brace sets, then grow large enough to exhaust memory and crash the process
// (CVE-2026-14257). `EXPANSION_MAX_LENGTH` bounds the total number of
// characters the accumulator may hold at any point, so memory stays flat no
// matter how many brace groups are chained. The limit sits well above any
// realistic expansion (100k results hitting `EXPANSION_MAX` measure ~1M
// characters) so legitimate input is unaffected.
exports.EXPANSION_MAX_LENGTH = 4_000_000;
// `expand_` recurses once per level of brace *nesting* - both when expanding a
// set's comma members and when re-wrapping a set whose body is a single part.
// The CVE-2026-14257 fix made the *tail* iterative (recursion on `m.post`, one
// level per chained group), which left nesting depth unbounded: about 3,100
// levels of `{{{...a,b...}}}` - only ~6KB of input - exhausted the native stack
// and crashed the process. `EXPANSION_MAX_DEPTH` bounds how deep the parser
// will follow nesting. It sits far above any realistic pattern and well below
// the depth at which the stack runs out.
exports.EXPANSION_MAX_DEPTH = 1_000;
// Bash keeps a quirk where a brace group followed by a comma set still expands
// (`{a},b}`). The parser implements it by rewriting the string and restarting
// the scan, absorbing one `}` per pass. `n` trailing braces therefore cost `n`
// full passes over a string that itself grows by one `escClose` sentinel each
// time - quadratic in `n`, with a ~26x constant from the sentinel's length.
// 128KB of `'{a}' + '}'.repeat(n) + ',z}'` blocked the event loop for 27
// seconds to produce two results. `EXPANSION_MAX_REWRITES` bounds how many
// times the scan may restart. Real `{a},b}` input needs a handful.
exports.EXPANSION_MAX_REWRITES = 1_000;
function numeric(str) {
    return !isNaN(str) ? parseInt(str, 10) : str.charCodeAt(0);
}
function escapeBraces(str) {
    return str
        .replace(slashPattern, escSlash)
        .replace(openPattern, escOpen)
        .replace(closePattern, escClose)
        .replace(commaPattern, escComma)
        .replace(periodPattern, escPeriod);
}
function unescapeBraces(str) {
    return str
        .replace(escSlashPattern, '\\')
        .replace(escOpenPattern, '{')
        .replace(escClosePattern, '}')
        .replace(escCommaPattern, ',')
        .replace(escPeriodPattern, '.');
}
// Like `target.push(...items)` but doesn't overflow the stack
function pushAll(target, items) {
    for (let i = 0; i < items.length; i++) {
        target.push(items[i]);
    }
}
/**
 * Basically just str.split(","), but handling cases
 * where we have nested braced sections, which should be
 * treated as individual members, like {a,{b,c},d}
 */
function parseCommaParts(str) {
    const parts = [];
    // Walk the brace groups iteratively. Recursing on `post` once per group let a
    // chain of them exhaust the stack - the parsing-side counterpart to
    // the `expand_` overflow fixed for CVE-2026-14257, and not something `max` or
    // `maxLength` can bound, since it happens before expansion.
    //
    // The part the next chunk continues
    let carry = '';
    for (;;) {
        const m = (0, balanced_match_1.balanced)('{', '}', str);
        if (!m) {
            const tail = str.split(',');
            tail[0] = carry + tail[0];
            pushAll(parts, tail);
            return parts;
        }
        const { pre, body, post } = m;
        const p = pre.split(',');
        p[0] = carry + p[0];
        p[p.length - 1] += '{' + body + '}';
        if (!post.length) {
            pushAll(parts, p);
            return parts;
        }
        carry = p.pop();
        pushAll(parts, p);
        str = post;
    }
}
function expand(str, options = {}) {
    if (!str) {
        return [];
    }
    const { max = exports.EXPANSION_MAX, maxLength = exports.EXPANSION_MAX_LENGTH, maxDepth = exports.EXPANSION_MAX_DEPTH, maxRewrites = exports.EXPANSION_MAX_REWRITES, } = options;
    // I don't know why Bash 4.3 does this, but it does.
    // Anything starting with {} will have the first two bytes preserved
    // but *only* at the top level, so {},a}b will not expand to anything,
    // but a{},b}c will be expanded to [a}c,abc].
    // One could argue that this is a bug in Bash, but since the goal of
    // this module is to match Bash's rules, we escape a leading {}
    if (str.slice(0, 2) === '{}') {
        str = '\\{\\}' + str.slice(2);
    }
    return expand_(escapeBraces(str), max, maxLength, maxDepth, 0, maxRewrites, true).map(unescapeBraces);
}
function embrace(str) {
    return '{' + str + '}';
}
function isPadded(el) {
    return /^-?0\d/.test(el);
}
function lte(i, y) {
    return i <= y;
}
function gte(i, y) {
    return i >= y;
}
// Build `{ acc[a] + pre + values[v] }` for every combination, capping the
// number of results at `max` and the total number of characters at `maxLength`.
// This is the one place output grows, so bounding it here keeps the single
// accumulator - and therefore memory - flat regardless of how many brace groups
// are combined (CVE-2026-14257).
function combine(acc, pre, values, max, maxLength, dropEmpties) {
    const out = [];
    let length = 0;
    for (let a = 0; a < acc.length; a++) {
        for (let v = 0; v < values.length; v++) {
            if (out.length >= max)
                return out;
            const expansion = acc[a] + pre + values[v];
            // Bash drops empty results at the top level. Skip them before they count
            // against `max`, so `max` bounds the number of *kept* results.
            if (dropEmpties && !expansion)
                continue;
            if (length + expansion.length > maxLength)
                return out;
            out.push(expansion);
            length += expansion.length;
        }
    }
    return out;
}
// The expansion values of a single numeric (`1..5`) or alphabetic (`a..e..2`)
// sequence body.
function expandSequence(body, isAlphaSequence, max, maxLength) {
    const n = body.split(/\.\./);
    const N = [];
    // A sequence body always splits into two or three parts, but the compiler
    // can't know that.
    /* c8 ignore start */
    if (n[0] === undefined || n[1] === undefined) {
        return N;
    }
    /* c8 ignore stop */
    const x = numeric(n[0]);
    const y = numeric(n[1]);
    const width = Math.max(n[0].length, n[1].length);
    let incr = n.length === 3 && n[2] !== undefined ?
        Math.max(Math.abs(numeric(n[2])), 1)
        : 1;
    let test = lte;
    const reverse = y < x;
    if (reverse) {
        incr *= -1;
        test = gte;
    }
    const pad = n.some(isPadded);
    let length = 0;
    for (let i = x; test(i, y) && N.length < max; i += incr) {
        let c;
        if (isAlphaSequence) {
            c = String.fromCharCode(i);
            if (c === '\\') {
                c = '';
            }
        }
        else {
            c = String(i);
            if (pad) {
                const need = width - c.length;
                if (need > 0) {
                    const z = new Array(need + 1).join('0');
                    if (i < 0) {
                        c = '-' + z + c.slice(1);
                    }
                    else {
                        c = z + c;
                    }
                }
            }
        }
        if (length + c.length > maxLength)
            break;
        N.push(c);
        length += c.length;
    }
    return N;
}
function expand_(str, max, maxLength, maxDepth, depth, maxRewrites, isTop) {
    // Too deeply nested to keep following: treat the rest as literal, the same
    // way a group that cannot expand is already handled. Truncating rather than
    // throwing keeps `expand` total, matching `max` and `maxLength`.
    if (depth > maxDepth) {
        return [str];
    }
    // Consume the string's top-level brace groups left to right, threading a
    // running set of combined prefixes (`acc`). Expanding the tail iteratively -
    // rather than recursing on `m.post` once per group - keeps the native stack
    // depth constant, so deeply chained input (`'{a,b}'.repeat(3000)`) can no
    // longer overflow the stack, and leaves a single accumulator whose size
    // `maxLength` bounds directly (CVE-2026-14257).
    let acc = [''];
    // Bash drops empty results, but only when the *first* top-level group is a
    // comma set - a sequence like `{a..\}` may legitimately yield ''. The drop
    // is on the final strings, so it is applied to whichever `combine` produces
    // them (the one with no brace set left in the tail).
    // How many times the `{a},b}` rewrite below has restarted the scan. Each pass
    // re-reads the whole string, so leaving this unbounded is quadratic.
    let rewrites = 0;
    let dropEmpties = false;
    let firstGroup = true;
    for (;;) {
        const m = (0, balanced_match_1.balanced)('{', '}', str);
        // No brace set left: the rest of the string is literal.
        if (!m) {
            return combine(acc, str, [''], max, maxLength, dropEmpties);
        }
        // no need to expand pre, since it is guaranteed to be free of brace-sets
        const pre = m.pre;
        if (/\$$/.test(pre)) {
            acc = combine(acc, pre + '{' + m.body + '}', [''], max, maxLength, dropEmpties && !m.post.length);
            firstGroup = false;
            if (!m.post.length)
                break;
            str = m.post;
            continue;
        }
        const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
        const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
        const isSequence = isNumericSequence || isAlphaSequence;
        const isOptions = m.body.indexOf(',') >= 0;
        if (!isSequence && !isOptions) {
            // {a},b}
            if (rewrites < maxRewrites && m.post.match(/,(?!,).*\}/)) {
                rewrites++;
                str = m.pre + '{' + m.body + escClose + m.post;
                isTop = true;
                continue;
            }
            // Nothing here expands, so the whole remaining string is literal.
            return combine(acc, pre + '{' + m.body + '}' + m.post, [''], max, maxLength, dropEmpties);
        }
        if (firstGroup) {
            dropEmpties = isTop && !isSequence;
            firstGroup = false;
        }
        let values;
        if (isSequence) {
            values = expandSequence(m.body, isAlphaSequence, max, maxLength);
        }
        else {
            let n = parseCommaParts(m.body);
            if (n.length === 1 && n[0] !== undefined) {
                // x{{a,b}}y ==> x{a}y x{b}y
                n = expand_(n[0], max, maxLength, maxDepth, depth + 1, maxRewrites, false).map(embrace);
                //XXX is this necessary? Can't seem to hit it in tests.
                /* c8 ignore start */
                if (n.length === 1) {
                    acc = combine(acc, pre + n[0], [''], max, maxLength, dropEmpties && !m.post.length);
                    if (!m.post.length)
                        break;
                    str = m.post;
                    continue;
                }
                /* c8 ignore stop */
            }
            // Values that `combine` is going to drop as empty produce no result, so
            // they must not count against `max` - otherwise `{a,,b}` with `max: 2`
            // would stop at `['a', '']` and yield one result instead of two. Skipping
            // them outright keeps `values` bounded while leaving `max` a bound on
            // *kept* results.
            let dropsEmpties = dropEmpties && !m.post.length && !pre;
            for (let d = 0; dropsEmpties && d < acc.length; d++) {
                if (acc[d]) {
                    dropsEmpties = false;
                }
            }
            values = [];
            let valuesLength = 0;
            outer: for (let j = 0; j < n.length; j++) {
                const expanded = expand_(n[j], max, maxLength, maxDepth, depth + 1, maxRewrites, false);
                for (let k = 0; k < expanded.length; k++) {
                    const v = expanded[k];
                    if (dropsEmpties && !v)
                        continue;
                    if (values.length >= max ||
                        valuesLength + v.length > maxLength) {
                        break outer;
                    }
                    values.push(v);
                    valuesLength += v.length;
                }
            }
        }
        acc = combine(acc, pre, values, max, maxLength, dropEmpties && !m.post.length);
        if (!m.post.length)
            break;
        str = m.post;
    }
    return acc;
}
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 305:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.assertValidPattern = void 0;
const MAX_PATTERN_LENGTH = 1024 * 64;
const assertValidPattern = (pattern) => {
    if (typeof pattern !== 'string') {
        throw new TypeError('invalid pattern');
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new TypeError('pattern is too long');
    }
};
exports.assertValidPattern = assertValidPattern;
//# sourceMappingURL=assert-valid-pattern.js.map

/***/ }),

/***/ 803:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


// parse a single path portion
var _a;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AST = void 0;
const brace_expressions_js_1 = __nccwpck_require__(90);
const unescape_js_1 = __nccwpck_require__(851);
const types = new Set(['!', '?', '+', '*', '@']);
const isExtglobType = (c) => types.has(c);
const isExtglobAST = (c) => isExtglobType(c.type);
// Map of which extglob types can adopt the children of a nested extglob
//
// anything but ! can adopt a matching type:
// +(a|+(b|c)|d) => +(a|b|c|d)
// *(a|*(b|c)|d) => *(a|b|c|d)
// @(a|@(b|c)|d) => @(a|b|c|d)
// ?(a|?(b|c)|d) => ?(a|b|c|d)
//
// * can adopt anything, because 0 or repetition is allowed
// *(a|?(b|c)|d) => *(a|b|c|d)
// *(a|+(b|c)|d) => *(a|b|c|d)
// *(a|@(b|c)|d) => *(a|b|c|d)
//
// + can adopt @, because 1 or repetition is allowed
// +(a|@(b|c)|d) => +(a|b|c|d)
//
// + and @ CANNOT adopt *, because 0 would be allowed
// +(a|*(b|c)|d) => would match "", on *(b|c)
// @(a|*(b|c)|d) => would match "", on *(b|c)
//
// + and @ CANNOT adopt ?, because 0 would be allowed
// +(a|?(b|c)|d) => would match "", on ?(b|c)
// @(a|?(b|c)|d) => would match "", on ?(b|c)
//
// ? can adopt @, because 0 or 1 is allowed
// ?(a|@(b|c)|d) => ?(a|b|c|d)
//
// ? and @ CANNOT adopt * or +, because >1 would be allowed
// ?(a|*(b|c)|d) => would match bbb on *(b|c)
// @(a|*(b|c)|d) => would match bbb on *(b|c)
// ?(a|+(b|c)|d) => would match bbb on +(b|c)
// @(a|+(b|c)|d) => would match bbb on +(b|c)
//
// ! CANNOT adopt ! (nothing else can either)
// !(a|!(b|c)|d) => !(a|b|c|d) would fail to match on b (not not b|c)
//
// ! can adopt @
// !(a|@(b|c)|d) => !(a|b|c|d)
//
// ! CANNOT adopt *
// !(a|*(b|c)|d) => !(a|b|c|d) would match on bbb, not allowed
//
// ! CANNOT adopt +
// !(a|+(b|c)|d) => !(a|b|c|d) would match on bbb, not allowed
//
// ! CANNOT adopt ?
// x!(a|?(b|c)|d) => x!(a|b|c|d) would fail to match "x"
const adoptionMap = new Map([
    ['!', ['@']],
    ['?', ['?', '@']],
    ['@', ['@']],
    ['*', ['*', '+', '?', '@']],
    ['+', ['+', '@']],
]);
// nested extglobs that can be adopted in, but with the addition of
// a blank '' element.
const adoptionWithSpaceMap = new Map([
    ['!', ['?']],
    ['@', ['?']],
    ['+', ['?', '*']],
]);
// union of the previous two maps
const adoptionAnyMap = new Map([
    ['!', ['?', '@']],
    ['?', ['?', '@']],
    ['@', ['?', '@']],
    ['*', ['*', '+', '?', '@']],
    ['+', ['+', '@', '?', '*']],
]);
// Extglobs that can take over their parent if they are the only child
// the key is parent, value maps child to resulting extglob parent type
// '@' is omitted because it's a special case. An `@` extglob with a single
// member can always be usurped by that subpattern.
const usurpMap = new Map([
    ['!', new Map([['!', '@']])],
    [
        '?',
        new Map([
            ['*', '*'],
            ['+', '*'],
        ]),
    ],
    [
        '@',
        new Map([
            ['!', '!'],
            ['?', '?'],
            ['@', '@'],
            ['*', '*'],
            ['+', '+'],
        ]),
    ],
    [
        '+',
        new Map([
            ['?', '*'],
            ['*', '*'],
        ]),
    ],
]);
// Patterns that get prepended to bind to the start of either the
// entire string, or just a single path portion, to prevent dots
// and/or traversal patterns, when needed.
// Exts don't need the ^ or / bit, because the root binds that already.
const startNoTraversal = '(?!(?:^|/)\\.\\.?(?:$|/))';
const startNoDot = '(?!\\.)';
// characters that indicate a start of pattern needs the "no dots" bit,
// because a dot *might* be matched. ( is not in the list, because in
// the case of a child extglob, it will handle the prevention itself.
const addPatternStart = new Set(['[', '.']);
// cases where traversal is A-OK, no dot prevention needed
const justDots = new Set(['..', '.']);
const reSpecials = new Set('().*{}+?[]^$\\!');
const regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
// any single thing other than /
const qmark = '[^/]';
// * => any number of characters
const star = qmark + '*?';
// use + when we need to ensure that *something* matches, because the * is
// the only thing in the path portion.
const starNoEmpty = qmark + '+?';
// remove the \ chars that we added if we end up doing a nonmagic compare
// const deslash = (s: string) => s.replace(/\\(.)/g, '$1')
let ID = 0;
class AST {
    type;
    #root;
    #hasMagic;
    #uflag = false;
    #parts = [];
    #parent;
    #parentIndex;
    #negs;
    #filledNegs = false;
    #options;
    #toString;
    // set to true if it's an extglob with no children
    // (which really means one child of '')
    #emptyExt = false;
    id = ++ID;
    get depth() {
        return (this.#parent?.depth ?? -1) + 1;
    }
    [Symbol.for('nodejs.util.inspect.custom')]() {
        return {
            '@@type': 'AST',
            id: this.id,
            type: this.type,
            root: this.#root.id,
            parent: this.#parent?.id,
            depth: this.depth,
            partsLength: this.#parts.length,
            parts: this.#parts,
        };
    }
    constructor(type, parent, options = {}) {
        this.type = type;
        // extglobs are inherently magical
        if (type)
            this.#hasMagic = true;
        this.#parent = parent;
        this.#root = this.#parent ? this.#parent.#root : this;
        this.#options = this.#root === this ? options : this.#root.#options;
        this.#negs = this.#root === this ? [] : this.#root.#negs;
        if (type === '!' && !this.#root.#filledNegs)
            this.#negs.push(this);
        this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
    }
    get hasMagic() {
        /* c8 ignore start */
        if (this.#hasMagic !== undefined)
            return this.#hasMagic;
        /* c8 ignore stop */
        for (const p of this.#parts) {
            if (typeof p === 'string')
                continue;
            if (p.type || p.hasMagic)
                return (this.#hasMagic = true);
        }
        // note: will be undefined until we generate the regexp src and find out
        return this.#hasMagic;
    }
    // reconstructs the pattern
    toString() {
        return (this.#toString !== undefined ? this.#toString
            : !this.type ?
                (this.#toString = this.#parts.map(p => String(p)).join(''))
                : (this.#toString =
                    this.type +
                        '(' +
                        this.#parts.map(p => String(p)).join('|') +
                        ')'));
    }
    #fillNegs() {
        /* c8 ignore start */
        if (this !== this.#root)
            throw new Error('should only call on root');
        if (this.#filledNegs)
            return this;
        /* c8 ignore stop */
        // call toString() once to fill this out
        this.toString();
        this.#filledNegs = true;
        let n;
        while ((n = this.#negs.pop())) {
            if (n.type !== '!')
                continue;
            // walk up the tree, appending everthing that comes AFTER parentIndex
            let p = n;
            let pp = p.#parent;
            while (pp) {
                for (let i = p.#parentIndex + 1; !pp.type && i < pp.#parts.length; i++) {
                    for (const part of n.#parts) {
                        /* c8 ignore start */
                        if (typeof part === 'string') {
                            throw new Error('string part in extglob AST??');
                        }
                        /* c8 ignore stop */
                        part.copyIn(pp.#parts[i]);
                    }
                }
                p = pp;
                pp = p.#parent;
            }
        }
        return this;
    }
    push(...parts) {
        for (const p of parts) {
            if (p === '')
                continue;
            /* c8 ignore start */
            if (typeof p !== 'string' &&
                !(p instanceof _a && p.#parent === this)) {
                throw new Error('invalid part: ' + p);
            }
            /* c8 ignore stop */
            this.#parts.push(p);
        }
    }
    toJSON() {
        const ret = this.type === null ?
            this.#parts
                .slice()
                .map(p => (typeof p === 'string' ? p : p.toJSON()))
            : [this.type, ...this.#parts.map(p => p.toJSON())];
        if (this.isStart() && !this.type)
            ret.unshift([]);
        if (this.isEnd() &&
            (this === this.#root ||
                (this.#root.#filledNegs && this.#parent?.type === '!'))) {
            ret.push({});
        }
        return ret;
    }
    isStart() {
        if (this.#root === this)
            return true;
        // if (this.type) return !!this.#parent?.isStart()
        if (!this.#parent?.isStart())
            return false;
        if (this.#parentIndex === 0)
            return true;
        // if everything AHEAD of this is a negation, then it's still the "start"
        const p = this.#parent;
        for (let i = 0; i < this.#parentIndex; i++) {
            const pp = p.#parts[i];
            if (!(pp instanceof _a && pp.type === '!')) {
                return false;
            }
        }
        return true;
    }
    isEnd() {
        if (this.#root === this)
            return true;
        if (this.#parent?.type === '!')
            return true;
        if (!this.#parent?.isEnd())
            return false;
        if (!this.type)
            return this.#parent?.isEnd();
        // if not root, it'll always have a parent
        /* c8 ignore start */
        const pl = this.#parent ? this.#parent.#parts.length : 0;
        /* c8 ignore stop */
        return this.#parentIndex === pl - 1;
    }
    copyIn(part) {
        if (typeof part === 'string')
            this.push(part);
        else
            this.push(part.clone(this));
    }
    clone(parent) {
        const c = new _a(this.type, parent);
        for (const p of this.#parts) {
            c.copyIn(p);
        }
        return c;
    }
    static #parseAST(str, ast, pos, opt, extDepth) {
        const maxDepth = opt.maxExtglobRecursion ?? 2;
        let escaping = false;
        let inBrace = false;
        let braceStart = -1;
        let braceNeg = false;
        if (ast.type === null) {
            // outside of a extglob, append until we find a start
            let i = pos;
            let acc = '';
            while (i < str.length) {
                const c = str.charAt(i++);
                // still accumulate escapes at this point, but we do ignore
                // starts that are escaped
                if (escaping || c === '\\') {
                    escaping = !escaping;
                    acc += c;
                    continue;
                }
                if (inBrace) {
                    if (i === braceStart + 1) {
                        if (c === '^' || c === '!') {
                            braceNeg = true;
                        }
                    }
                    else if (c === ']' && !(i === braceStart + 2 && braceNeg)) {
                        inBrace = false;
                    }
                    acc += c;
                    continue;
                }
                else if (c === '[') {
                    inBrace = true;
                    braceStart = i;
                    braceNeg = false;
                    acc += c;
                    continue;
                }
                // we don't have to check for adoption here, because that's
                // done at the other recursion point.
                const doRecurse = !opt.noext &&
                    isExtglobType(c) &&
                    str.charAt(i) === '(' &&
                    extDepth <= maxDepth;
                if (doRecurse) {
                    ast.push(acc);
                    acc = '';
                    const ext = new _a(c, ast);
                    i = _a.#parseAST(str, ext, i, opt, extDepth + 1);
                    ast.push(ext);
                    continue;
                }
                acc += c;
            }
            ast.push(acc);
            return i;
        }
        // some kind of extglob, pos is at the (
        // find the next | or )
        let i = pos + 1;
        let part = new _a(null, ast);
        const parts = [];
        let acc = '';
        while (i < str.length) {
            const c = str.charAt(i++);
            // still accumulate escapes at this point, but we do ignore
            // starts that are escaped
            if (escaping || c === '\\') {
                escaping = !escaping;
                acc += c;
                continue;
            }
            if (inBrace) {
                if (i === braceStart + 1) {
                    if (c === '^' || c === '!') {
                        braceNeg = true;
                    }
                }
                else if (c === ']' && !(i === braceStart + 2 && braceNeg)) {
                    inBrace = false;
                }
                acc += c;
                continue;
            }
            else if (c === '[') {
                inBrace = true;
                braceStart = i;
                braceNeg = false;
                acc += c;
                continue;
            }
            const doRecurse = !opt.noext &&
                isExtglobType(c) &&
                str.charAt(i) === '(' &&
                /* c8 ignore start - the maxDepth is sufficient here */
                (extDepth <= maxDepth || (ast && ast.#canAdoptType(c)));
            /* c8 ignore stop */
            if (doRecurse) {
                const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
                part.push(acc);
                acc = '';
                const ext = new _a(c, part);
                part.push(ext);
                i = _a.#parseAST(str, ext, i, opt, extDepth + depthAdd);
                continue;
            }
            if (c === '|') {
                part.push(acc);
                acc = '';
                parts.push(part);
                part = new _a(null, ast);
                continue;
            }
            if (c === ')') {
                if (acc === '' && ast.#parts.length === 0) {
                    ast.#emptyExt = true;
                }
                part.push(acc);
                acc = '';
                ast.push(...parts, part);
                return i;
            }
            acc += c;
        }
        // unfinished extglob
        // if we got here, it was a malformed extglob! not an extglob, but
        // maybe something else in there.
        ast.type = null;
        ast.#hasMagic = undefined;
        ast.#parts = [str.substring(pos - 1)];
        return i;
    }
    #canAdoptWithSpace(child) {
        return this.#canAdopt(child, adoptionWithSpaceMap);
    }
    #canAdopt(child, map = adoptionMap) {
        if (!child ||
            typeof child !== 'object' ||
            child.type !== null ||
            child.#parts.length !== 1 ||
            this.type === null) {
            return false;
        }
        const gc = child.#parts[0];
        if (!gc || typeof gc !== 'object' || gc.type === null) {
            return false;
        }
        return this.#canAdoptType(gc.type, map);
    }
    #canAdoptType(c, map = adoptionAnyMap) {
        return !!map.get(this.type)?.includes(c);
    }
    #adoptWithSpace(child, index) {
        const gc = child.#parts[0];
        const blank = new _a(null, gc, this.options);
        blank.#parts.push('');
        gc.push(blank);
        this.#adopt(child, index);
    }
    #adopt(child, index) {
        const gc = child.#parts[0];
        this.#parts.splice(index, 1, ...gc.#parts);
        for (const p of gc.#parts) {
            if (typeof p === 'object')
                p.#parent = this;
        }
        this.#toString = undefined;
    }
    #canUsurpType(c) {
        const m = usurpMap.get(this.type);
        return !!m?.has(c);
    }
    #canUsurp(child) {
        if (!child ||
            typeof child !== 'object' ||
            child.type !== null ||
            child.#parts.length !== 1 ||
            this.type === null ||
            this.#parts.length !== 1) {
            return false;
        }
        const gc = child.#parts[0];
        if (!gc || typeof gc !== 'object' || gc.type === null) {
            return false;
        }
        return this.#canUsurpType(gc.type);
    }
    #usurp(child) {
        const m = usurpMap.get(this.type);
        const gc = child.#parts[0];
        const nt = m?.get(gc.type);
        /* c8 ignore start - impossible */
        if (!nt)
            return false;
        /* c8 ignore stop */
        this.#parts = gc.#parts;
        for (const p of this.#parts) {
            if (typeof p === 'object') {
                p.#parent = this;
            }
        }
        this.type = nt;
        this.#toString = undefined;
        this.#emptyExt = false;
    }
    static fromGlob(pattern, options = {}) {
        const ast = new _a(null, undefined, options);
        _a.#parseAST(pattern, ast, 0, options, 0);
        return ast;
    }
    // returns the regular expression if there's magic, or the unescaped
    // string if not.
    toMMPattern() {
        // should only be called on root
        /* c8 ignore start */
        if (this !== this.#root)
            return this.#root.toMMPattern();
        /* c8 ignore stop */
        const glob = this.toString();
        const [re, body, hasMagic, uflag] = this.toRegExpSource();
        // if we're in nocase mode, and not nocaseMagicOnly, then we do
        // still need a regular expression if we have to case-insensitively
        // match capital/lowercase characters.
        const anyMagic = hasMagic ||
            this.#hasMagic ||
            (this.#options.nocase &&
                !this.#options.nocaseMagicOnly &&
                glob.toUpperCase() !== glob.toLowerCase());
        if (!anyMagic) {
            return body;
        }
        const flags = (this.#options.nocase ? 'i' : '') + (uflag ? 'u' : '');
        return Object.assign(new RegExp(`^${re}$`, flags), {
            _src: re,
            _glob: glob,
        });
    }
    get options() {
        return this.#options;
    }
    // returns the string match, the regexp source, whether there's magic
    // in the regexp (so a regular expression is required) and whether or
    // not the uflag is needed for the regular expression (for posix classes)
    // TODO: instead of injecting the start/end at this point, just return
    // the BODY of the regexp, along with the start/end portions suitable
    // for binding the start/end in either a joined full-path makeRe context
    // (where we bind to (^|/), or a standalone matchPart context (where
    // we bind to ^, and not /).  Otherwise slashes get duped!
    //
    // In part-matching mode, the start is:
    // - if not isStart: nothing
    // - if traversal possible, but not allowed: ^(?!\.\.?$)
    // - if dots allowed or not possible: ^
    // - if dots possible and not allowed: ^(?!\.)
    // end is:
    // - if not isEnd(): nothing
    // - else: $
    //
    // In full-path matching mode, we put the slash at the START of the
    // pattern, so start is:
    // - if first pattern: same as part-matching mode
    // - if not isStart(): nothing
    // - if traversal possible, but not allowed: /(?!\.\.?(?:$|/))
    // - if dots allowed or not possible: /
    // - if dots possible and not allowed: /(?!\.)
    // end is:
    // - if last pattern, same as part-matching mode
    // - else nothing
    //
    // Always put the (?:$|/) on negated tails, though, because that has to be
    // there to bind the end of the negated pattern portion, and it's easier to
    // just stick it in now rather than try to inject it later in the middle of
    // the pattern.
    //
    // We can just always return the same end, and leave it up to the caller
    // to know whether it's going to be used joined or in parts.
    // And, if the start is adjusted slightly, can do the same there:
    // - if not isStart: nothing
    // - if traversal possible, but not allowed: (?:/|^)(?!\.\.?$)
    // - if dots allowed or not possible: (?:/|^)
    // - if dots possible and not allowed: (?:/|^)(?!\.)
    //
    // But it's better to have a simpler binding without a conditional, for
    // performance, so probably better to return both start options.
    //
    // Then the caller just ignores the end if it's not the first pattern,
    // and the start always gets applied.
    //
    // But that's always going to be $ if it's the ending pattern, or nothing,
    // so the caller can just attach $ at the end of the pattern when building.
    //
    // So the todo is:
    // - better detect what kind of start is needed
    // - return both flavors of starting pattern
    // - attach $ at the end of the pattern when creating the actual RegExp
    //
    // Ah, but wait, no, that all only applies to the root when the first pattern
    // is not an extglob. If the first pattern IS an extglob, then we need all
    // that dot prevention biz to live in the extglob portions, because eg
    // +(*|.x*) can match .xy but not .yx.
    //
    // So, return the two flavors if it's #root and the first child is not an
    // AST, otherwise leave it to the child AST to handle it, and there,
    // use the (?:^|/) style of start binding.
    //
    // Even simplified further:
    // - Since the start for a join is eg /(?!\.) and the start for a part
    // is ^(?!\.), we can just prepend (?!\.) to the pattern (either root
    // or start or whatever) and prepend ^ or / at the Regexp construction.
    toRegExpSource(allowDot) {
        const dot = allowDot ?? !!this.#options.dot;
        if (this.#root === this) {
            this.#flatten();
            this.#fillNegs();
        }
        if (!isExtglobAST(this)) {
            const noEmpty = this.isStart() &&
                this.isEnd() &&
                !this.#parts.some(s => typeof s !== 'string');
            const src = this.#parts
                .map(p => {
                const [re, _, hasMagic, uflag] = typeof p === 'string' ?
                    _a.#parseGlob(p, this.#hasMagic, noEmpty)
                    : p.toRegExpSource(allowDot);
                this.#hasMagic = this.#hasMagic || hasMagic;
                this.#uflag = this.#uflag || uflag;
                return re;
            })
                .join('');
            let start = '';
            if (this.isStart()) {
                if (typeof this.#parts[0] === 'string') {
                    // this is the string that will match the start of the pattern,
                    // so we need to protect against dots and such.
                    // '.' and '..' cannot match unless the pattern is that exactly,
                    // even if it starts with . or dot:true is set.
                    const dotTravAllowed = this.#parts.length === 1 && justDots.has(this.#parts[0]);
                    if (!dotTravAllowed) {
                        const aps = addPatternStart;
                        // check if we have a possibility of matching . or ..,
                        // and prevent that.
                        const needNoTrav = 
                        // dots are allowed, and the pattern starts with [ or .
                        (dot && aps.has(src.charAt(0))) ||
                            // the pattern starts with \., and then [ or .
                            (src.startsWith('\\.') && aps.has(src.charAt(2))) ||
                            // the pattern starts with \.\., and then [ or .
                            (src.startsWith('\\.\\.') && aps.has(src.charAt(4)));
                        // no need to prevent dots if it can't match a dot, or if a
                        // sub-pattern will be preventing it anyway.
                        const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
                        start =
                            needNoTrav ? startNoTraversal
                                : needNoDot ? startNoDot
                                    : '';
                    }
                }
            }
            // append the "end of path portion" pattern to negation tails
            let end = '';
            if (this.isEnd() &&
                this.#root.#filledNegs &&
                this.#parent?.type === '!') {
                end = '(?:$|\\/)';
            }
            const final = start + src + end;
            return [
                final,
                (0, unescape_js_1.unescape)(src),
                (this.#hasMagic = !!this.#hasMagic),
                this.#uflag,
            ];
        }
        // We need to calculate the body *twice* if it's a repeat pattern
        // at the start, once in nodot mode, then again in dot mode, so a
        // pattern like *(?) can match 'x.y'
        const repeated = this.type === '*' || this.type === '+';
        // some kind of extglob
        const start = this.type === '!' ? '(?:(?!(?:' : '(?:';
        let body = this.#partsToRegExp(dot);
        if (this.isStart() && this.isEnd() && !body && this.type !== '!') {
            // invalid extglob, has to at least be *something* present, if it's
            // the entire path portion.
            const s = this.toString();
            const me = this;
            me.#parts = [s];
            me.type = null;
            me.#hasMagic = undefined;
            return [s, (0, unescape_js_1.unescape)(this.toString()), false, false];
        }
        let bodyDotAllowed = !repeated || allowDot || dot || !startNoDot ?
            ''
            : this.#partsToRegExp(true);
        if (bodyDotAllowed === body) {
            bodyDotAllowed = '';
        }
        if (bodyDotAllowed) {
            body = `(?:${body})(?:${bodyDotAllowed})*?`;
        }
        // an empty !() is exactly equivalent to a starNoEmpty
        let final = '';
        if (this.type === '!' && this.#emptyExt) {
            final = (this.isStart() && !dot ? startNoDot : '') + starNoEmpty;
        }
        else {
            const close = this.type === '!' ?
                // !() must match something,but !(x) can match ''
                '))' +
                    (this.isStart() && !dot && !allowDot ? startNoDot : '') +
                    star +
                    ')'
                : this.type === '@' ? ')'
                    : this.type === '?' ? ')?'
                        : this.type === '+' && bodyDotAllowed ? ')'
                            : this.type === '*' && bodyDotAllowed ? `)?`
                                : `)${this.type}`;
            final = start + body + close;
        }
        return [
            final,
            (0, unescape_js_1.unescape)(body),
            (this.#hasMagic = !!this.#hasMagic),
            this.#uflag,
        ];
    }
    #flatten() {
        if (!isExtglobAST(this)) {
            for (const p of this.#parts) {
                if (typeof p === 'object') {
                    p.#flatten();
                }
            }
        }
        else {
            // do up to 10 passes to flatten as much as possible
            let iterations = 0;
            let done = false;
            do {
                done = true;
                for (let i = 0; i < this.#parts.length; i++) {
                    const c = this.#parts[i];
                    if (typeof c === 'object') {
                        c.#flatten();
                        if (this.#canAdopt(c)) {
                            done = false;
                            this.#adopt(c, i);
                        }
                        else if (this.#canAdoptWithSpace(c)) {
                            done = false;
                            this.#adoptWithSpace(c, i);
                        }
                        else if (this.#canUsurp(c)) {
                            done = false;
                            this.#usurp(c);
                        }
                    }
                }
            } while (!done && ++iterations < 10);
        }
        this.#toString = undefined;
    }
    #partsToRegExp(dot) {
        return this.#parts
            .map(p => {
            // extglob ASTs should only contain parent ASTs
            /* c8 ignore start */
            if (typeof p === 'string') {
                throw new Error('string type in extglob ast??');
            }
            /* c8 ignore stop */
            // can ignore hasMagic, because extglobs are already always magic
            const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
            this.#uflag = this.#uflag || uflag;
            return re;
        })
            .filter(p => !(this.isStart() && this.isEnd()) || !!p)
            .join('|');
    }
    static #parseGlob(glob, hasMagic, noEmpty = false) {
        let escaping = false;
        let re = '';
        let uflag = false;
        // multiple stars that aren't globstars coalesce into one *
        let inStar = false;
        for (let i = 0; i < glob.length; i++) {
            const c = glob.charAt(i);
            if (escaping) {
                escaping = false;
                re += (reSpecials.has(c) ? '\\' : '') + c;
                continue;
            }
            if (c === '*') {
                if (inStar)
                    continue;
                inStar = true;
                re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star;
                hasMagic = true;
                continue;
            }
            else {
                inStar = false;
            }
            if (c === '\\') {
                if (i === glob.length - 1) {
                    re += '\\\\';
                }
                else {
                    escaping = true;
                }
                continue;
            }
            if (c === '[') {
                const [src, needUflag, consumed, magic] = (0, brace_expressions_js_1.parseClass)(glob, i);
                if (consumed) {
                    re += src;
                    uflag = uflag || needUflag;
                    i += consumed - 1;
                    hasMagic = hasMagic || magic;
                    continue;
                }
            }
            if (c === '?') {
                re += qmark;
                hasMagic = true;
                continue;
            }
            re += regExpEscape(c);
        }
        return [re, (0, unescape_js_1.unescape)(glob), !!hasMagic, uflag];
    }
}
exports.AST = AST;
_a = AST;
//# sourceMappingURL=ast.js.map

/***/ }),

/***/ 90:
/***/ ((__unused_webpack_module, exports) => {


// translate the various posix character classes into unicode properties
// this works across all unicode locales
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseClass = void 0;
// { <posix class>: [<translation>, /u flag required, negated]
const posixClasses = {
    '[:alnum:]': ['\\p{L}\\p{Nl}\\p{Nd}', true],
    '[:alpha:]': ['\\p{L}\\p{Nl}', true],
    '[:ascii:]': ['\\x' + '00-\\x' + '7f', false],
    '[:blank:]': ['\\p{Zs}\\t', true],
    '[:cntrl:]': ['\\p{Cc}', true],
    '[:digit:]': ['\\p{Nd}', true],
    '[:graph:]': ['\\p{Z}\\p{C}', true, true],
    '[:lower:]': ['\\p{Ll}', true],
    '[:print:]': ['\\p{C}', true],
    '[:punct:]': ['\\p{P}', true],
    '[:space:]': ['\\p{Z}\\t\\r\\n\\v\\f', true],
    '[:upper:]': ['\\p{Lu}', true],
    '[:word:]': ['\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}', true],
    '[:xdigit:]': ['A-Fa-f0-9', false],
};
// only need to escape a few things inside of brace expressions
// escapes: [ \ ] -
const braceEscape = (s) => s.replace(/[[\]\\-]/g, '\\$&');
// escape all regexp magic characters
const regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
// everything has already been escaped, we just have to join
const rangesToString = (ranges) => ranges.join('');
// takes a glob string at a posix brace expression, and returns
// an equivalent regular expression source, and boolean indicating
// whether the /u flag needs to be applied, and the number of chars
// consumed to parse the character class.
// This also removes out of order ranges, and returns ($.) if the
// entire class just no good.
const parseClass = (glob, position) => {
    const pos = position;
    /* c8 ignore start */
    if (glob.charAt(pos) !== '[') {
        throw new Error('not in a brace expression');
    }
    /* c8 ignore stop */
    const ranges = [];
    const negs = [];
    let i = pos + 1;
    let sawStart = false;
    let uflag = false;
    let escaping = false;
    let negate = false;
    let endPos = pos;
    let rangeStart = '';
    WHILE: while (i < glob.length) {
        const c = glob.charAt(i);
        if ((c === '!' || c === '^') && i === pos + 1) {
            negate = true;
            i++;
            continue;
        }
        if (c === ']' && sawStart && !escaping) {
            endPos = i + 1;
            break;
        }
        sawStart = true;
        if (c === '\\') {
            if (!escaping) {
                escaping = true;
                i++;
                continue;
            }
            // escaped \ char, fall through and treat like normal char
        }
        if (c === '[' && !escaping) {
            // either a posix class, a collation equivalent, or just a [
            for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) {
                if (glob.startsWith(cls, i)) {
                    // invalid, [a-[] is fine, but not [a-[:alpha]]
                    if (rangeStart) {
                        return ['$.', false, glob.length - pos, true];
                    }
                    i += cls.length;
                    if (neg)
                        negs.push(unip);
                    else
                        ranges.push(unip);
                    uflag = uflag || u;
                    continue WHILE;
                }
            }
        }
        // now it's just a normal character, effectively
        escaping = false;
        if (rangeStart) {
            // throw this range away if it's not valid, but others
            // can still match.
            if (c > rangeStart) {
                ranges.push(braceEscape(rangeStart) + '-' + braceEscape(c));
            }
            else if (c === rangeStart) {
                ranges.push(braceEscape(c));
            }
            rangeStart = '';
            i++;
            continue;
        }
        // now might be the start of a range.
        // can be either c-d or c-] or c<more...>] or c] at this point
        if (glob.startsWith('-]', i + 1)) {
            ranges.push(braceEscape(c + '-'));
            i += 2;
            continue;
        }
        if (glob.startsWith('-', i + 1)) {
            rangeStart = c;
            i += 2;
            continue;
        }
        // not the start of a range, just a single character
        ranges.push(braceEscape(c));
        i++;
    }
    if (endPos < i) {
        // didn't see the end of the class, not a valid class,
        // but might still be valid as a literal match.
        return ['', false, 0, false];
    }
    // if we got no ranges and no negates, then we have a range that
    // cannot possibly match anything, and that poisons the whole glob
    if (!ranges.length && !negs.length) {
        return ['$.', false, glob.length - pos, true];
    }
    // if we got one positive range, and it's a single character, then that's
    // not actually a magic pattern, it's just that one literal character.
    // we should not treat that as "magic", we should just return the literal
    // character. [_] is a perfectly valid way to escape glob magic chars.
    if (negs.length === 0 &&
        ranges.length === 1 &&
        /^\\?.$/.test(ranges[0]) &&
        !negate) {
        const r = ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0];
        return [regexpEscape(r), false, endPos - pos, false];
    }
    const sranges = '[' + (negate ? '^' : '') + rangesToString(ranges) + ']';
    const snegs = '[' + (negate ? '' : '^') + rangesToString(negs) + ']';
    const comb = ranges.length && negs.length ? '(' + sranges + '|' + snegs + ')'
        : ranges.length ? sranges
            : snegs;
    return [comb, uflag, endPos - pos, true];
};
exports.parseClass = parseClass;
//# sourceMappingURL=brace-expressions.js.map

/***/ }),

/***/ 800:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.escape = void 0;
/**
 * Escape all magic characters in a glob pattern.
 *
 * If the {@link MinimatchOptions.windowsPathsNoEscape}
 * option is used, then characters are escaped by wrapping in `[]`, because
 * a magic character wrapped in a character class can only be satisfied by
 * that exact character.  In this mode, `\` is _not_ escaped, because it is
 * not interpreted as a magic character, but instead as a path separator.
 *
 * If the {@link MinimatchOptions.magicalBraces} option is used,
 * then braces (`{` and `}`) will be escaped.
 */
const escape = (s, { windowsPathsNoEscape = false, magicalBraces = false, } = {}) => {
    // don't need to escape +@! because we escape the parens
    // that make those magic, and escaping ! as [!] isn't valid,
    // because [!]] is a valid glob class meaning not ']'.
    if (magicalBraces) {
        return windowsPathsNoEscape ?
            s.replace(/[?*()[\]{}]/g, '[$&]')
            : s.replace(/[?*()[\]\\{}]/g, '\\$&');
    }
    return windowsPathsNoEscape ?
        s.replace(/[?*()[\]]/g, '[$&]')
        : s.replace(/[?*()[\]\\]/g, '\\$&');
};
exports.escape = escape;
//# sourceMappingURL=escape.js.map

/***/ }),

/***/ 507:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.unescape = exports.escape = exports.AST = exports.Minimatch = exports.match = exports.makeRe = exports.braceExpand = exports.defaults = exports.filter = exports.GLOBSTAR = exports.sep = exports.minimatch = void 0;
const brace_expansion_1 = __nccwpck_require__(968);
const assert_valid_pattern_js_1 = __nccwpck_require__(305);
const ast_js_1 = __nccwpck_require__(803);
const escape_js_1 = __nccwpck_require__(800);
const unescape_js_1 = __nccwpck_require__(851);
const minimatch = (p, pattern, options = {}) => {
    (0, assert_valid_pattern_js_1.assertValidPattern)(pattern);
    // shortcut: comments match nothing.
    if (!options.nocomment && pattern.charAt(0) === '#') {
        return false;
    }
    return new Minimatch(pattern, options).match(p);
};
exports.minimatch = minimatch;
// Optimized checking for the most common glob patterns.
const starDotExtRE = /^\*+([^+@!?*[(]*)$/;
const starDotExtTest = (ext) => (f) => !f.startsWith('.') && f.endsWith(ext);
const starDotExtTestDot = (ext) => (f) => f.endsWith(ext);
const starDotExtTestNocase = (ext) => {
    ext = ext.toLowerCase();
    return (f) => !f.startsWith('.') && f.toLowerCase().endsWith(ext);
};
const starDotExtTestNocaseDot = (ext) => {
    ext = ext.toLowerCase();
    return (f) => f.toLowerCase().endsWith(ext);
};
const starDotStarRE = /^\*+\.\*+$/;
const starDotStarTest = (f) => !f.startsWith('.') && f.includes('.');
const starDotStarTestDot = (f) => f !== '.' && f !== '..' && f.includes('.');
const dotStarRE = /^\.\*+$/;
const dotStarTest = (f) => f !== '.' && f !== '..' && f.startsWith('.');
const starRE = /^\*+$/;
const starTest = (f) => f.length !== 0 && !f.startsWith('.');
const starTestDot = (f) => f.length !== 0 && f !== '.' && f !== '..';
const qmarksRE = /^\?+([^+@!?*[(]*)?$/;
const qmarksTestNocase = ([$0, ext = '']) => {
    const noext = qmarksTestNoExt([$0]);
    if (!ext)
        return noext;
    ext = ext.toLowerCase();
    return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestNocaseDot = ([$0, ext = '']) => {
    const noext = qmarksTestNoExtDot([$0]);
    if (!ext)
        return noext;
    ext = ext.toLowerCase();
    return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestDot = ([$0, ext = '']) => {
    const noext = qmarksTestNoExtDot([$0]);
    return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTest = ([$0, ext = '']) => {
    const noext = qmarksTestNoExt([$0]);
    return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTestNoExt = ([$0]) => {
    const len = $0.length;
    return (f) => f.length === len && !f.startsWith('.');
};
const qmarksTestNoExtDot = ([$0]) => {
    const len = $0.length;
    return (f) => f.length === len && f !== '.' && f !== '..';
};
/* c8 ignore start */
const defaultPlatform = (typeof process === 'object' && process ?
    (typeof process.env === 'object' &&
        process.env &&
        process.env.__MINIMATCH_TESTING_PLATFORM__) ||
        process.platform
    : 'posix');
const path = {
    win32: { sep: '\\' },
    posix: { sep: '/' },
};
/* c8 ignore stop */
exports.sep = defaultPlatform === 'win32' ? path.win32.sep : path.posix.sep;
exports.minimatch.sep = exports.sep;
exports.GLOBSTAR = Symbol('globstar **');
exports.minimatch.GLOBSTAR = exports.GLOBSTAR;
// any single thing other than /
// don't need to escape / when using new RegExp()
const qmark = '[^/]';
// * => any number of characters
const star = qmark + '*?';
// ** when dots are allowed.  Anything goes, except .. and .
// not (^ or / followed by one or two dots followed by $ or /),
// followed by anything, any number of times.
const twoStarDot = '(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?';
// not a ^ or / followed by a dot,
// followed by anything, any number of times.
const twoStarNoDot = '(?:(?!(?:\\/|^)\\.).)*?';
const filter = (pattern, options = {}) => (p) => (0, exports.minimatch)(p, pattern, options);
exports.filter = filter;
exports.minimatch.filter = exports.filter;
const ext = (a, b = {}) => Object.assign({}, a, b);
const defaults = (def) => {
    if (!def || typeof def !== 'object' || !Object.keys(def).length) {
        return exports.minimatch;
    }
    const orig = exports.minimatch;
    const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
    return Object.assign(m, {
        Minimatch: class Minimatch extends orig.Minimatch {
            constructor(pattern, options = {}) {
                super(pattern, ext(def, options));
            }
            static defaults(options) {
                return orig.defaults(ext(def, options)).Minimatch;
            }
        },
        AST: class AST extends orig.AST {
            /* c8 ignore start */
            constructor(type, parent, options = {}) {
                super(type, parent, ext(def, options));
            }
            /* c8 ignore stop */
            static fromGlob(pattern, options = {}) {
                return orig.AST.fromGlob(pattern, ext(def, options));
            }
        },
        unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
        escape: (s, options = {}) => orig.escape(s, ext(def, options)),
        filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
        defaults: (options) => orig.defaults(ext(def, options)),
        makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
        braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
        match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
        sep: orig.sep,
        GLOBSTAR: exports.GLOBSTAR,
    });
};
exports.defaults = defaults;
exports.minimatch.defaults = exports.defaults;
// Brace expansion:
// a{b,c}d -> abd acd
// a{b,}c -> abc ac
// a{0..3}d -> a0d a1d a2d a3d
// a{b,c{d,e}f}g -> abg acdfg acefg
// a{b,c}d{e,f}g -> abdeg acdeg abdeg abdfg
//
// Invalid sets are not expanded.
// a{2..}b -> a{2..}b
// a{b}c -> a{b}c
const braceExpand = (pattern, options = {}) => {
    (0, assert_valid_pattern_js_1.assertValidPattern)(pattern);
    // Thanks to Yeting Li <https://github.com/yetingli> for
    // improving this regexp to avoid a ReDOS vulnerability.
    if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) {
        // shortcut. no need to expand.
        return [pattern];
    }
    return (0, brace_expansion_1.expand)(pattern, { max: options.braceExpandMax });
};
exports.braceExpand = braceExpand;
exports.minimatch.braceExpand = exports.braceExpand;
// parse a component of the expanded set.
// At this point, no pattern may contain "/" in it
// so we're going to return a 2d array, where each entry is the full
// pattern, split on '/', and then turned into a regular expression.
// A regexp is made at the end which joins each array with an
// escaped /, and another full one which joins each regexp with |.
//
// Following the lead of Bash 4.1, note that "**" only has special meaning
// when it is the *only* thing in a path portion.  Otherwise, any series
// of * is equivalent to a single *.  Globstar behavior is enabled by
// default, and can be disabled by setting options.noglobstar.
const makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
exports.makeRe = makeRe;
exports.minimatch.makeRe = exports.makeRe;
const match = (list, pattern, options = {}) => {
    const mm = new Minimatch(pattern, options);
    list = list.filter(f => mm.match(f));
    if (mm.options.nonull && !list.length) {
        list.push(pattern);
    }
    return list;
};
exports.match = match;
exports.minimatch.match = exports.match;
// replace stuff like \* with *
const globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
const regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
class Minimatch {
    options;
    set;
    pattern;
    windowsPathsNoEscape;
    nonegate;
    negate;
    comment;
    empty;
    preserveMultipleSlashes;
    partial;
    globSet;
    globParts;
    nocase;
    isWindows;
    platform;
    windowsNoMagicRoot;
    maxGlobstarRecursion;
    regexp;
    constructor(pattern, options = {}) {
        (0, assert_valid_pattern_js_1.assertValidPattern)(pattern);
        options = options || {};
        this.options = options;
        this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
        this.pattern = pattern;
        this.platform = options.platform || defaultPlatform;
        this.isWindows = this.platform === 'win32';
        // avoid the annoying deprecation flag lol
        const awe = ('allowWindow' + 'sEscape');
        this.windowsPathsNoEscape =
            !!options.windowsPathsNoEscape || options[awe] === false;
        if (this.windowsPathsNoEscape) {
            this.pattern = this.pattern.replace(/\\/g, '/');
        }
        this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
        this.regexp = null;
        this.negate = false;
        this.nonegate = !!options.nonegate;
        this.comment = false;
        this.empty = false;
        this.partial = !!options.partial;
        this.nocase = !!this.options.nocase;
        this.windowsNoMagicRoot =
            options.windowsNoMagicRoot !== undefined ?
                options.windowsNoMagicRoot
                : !!(this.isWindows && this.nocase);
        this.globSet = [];
        this.globParts = [];
        this.set = [];
        // make the set of regexps etc.
        this.make();
    }
    hasMagic() {
        if (this.options.magicalBraces && this.set.length > 1) {
            return true;
        }
        for (const pattern of this.set) {
            for (const part of pattern) {
                if (typeof part !== 'string')
                    return true;
            }
        }
        return false;
    }
    debug(..._) { }
    make() {
        const pattern = this.pattern;
        const options = this.options;
        // empty patterns and comments match nothing.
        if (!options.nocomment && pattern.charAt(0) === '#') {
            this.comment = true;
            return;
        }
        if (!pattern) {
            this.empty = true;
            return;
        }
        // step 1: figure out negation, etc.
        this.parseNegate();
        // step 2: expand braces
        this.globSet = [...new Set(this.braceExpand())];
        if (options.debug) {
            //oxlint-disable-next-line no-console
            this.debug = (...args) => console.error(...args);
        }
        this.debug(this.pattern, this.globSet);
        // step 3: now we have a set, so turn each one into a series of
        // path-portion matching patterns.
        // These will be regexps, except in the case of "**", which is
        // set to the GLOBSTAR object for globstar behavior,
        // and will not contain any / characters
        //
        // First, we preprocess to make the glob pattern sets a bit simpler
        // and deduped.  There are some perf-killing patterns that can cause
        // problems with a glob walk, but we can simplify them down a bit.
        const rawGlobParts = this.globSet.map(s => this.slashSplit(s));
        this.globParts = this.preprocess(rawGlobParts);
        this.debug(this.pattern, this.globParts);
        // glob --> regexps
        let set = this.globParts.map((s, _, __) => {
            if (this.isWindows && this.windowsNoMagicRoot) {
                // check if it's a drive or unc path.
                const isUNC = s[0] === '' &&
                    s[1] === '' &&
                    (s[2] === '?' || !globMagic.test(s[2])) &&
                    !globMagic.test(s[3]);
                const isDrive = /^[a-z]:/i.test(s[0]);
                if (isUNC) {
                    return [
                        ...s.slice(0, 4),
                        ...s.slice(4).map(ss => this.parse(ss)),
                    ];
                }
                else if (isDrive) {
                    return [s[0], ...s.slice(1).map(ss => this.parse(ss))];
                }
            }
            return s.map(ss => this.parse(ss));
        });
        this.debug(this.pattern, set);
        // filter out everything that didn't compile properly.
        this.set = set.filter(s => s.indexOf(false) === -1);
        // do not treat the ? in UNC paths as magic
        if (this.isWindows) {
            for (let i = 0; i < this.set.length; i++) {
                const p = this.set[i];
                if (p[0] === '' &&
                    p[1] === '' &&
                    this.globParts[i][2] === '?' &&
                    typeof p[3] === 'string' &&
                    /^[a-z]:$/i.test(p[3])) {
                    p[2] = '?';
                }
            }
        }
        this.debug(this.pattern, this.set);
    }
    // various transforms to equivalent pattern sets that are
    // faster to process in a filesystem walk.  The goal is to
    // eliminate what we can, and push all ** patterns as far
    // to the right as possible, even if it increases the number
    // of patterns that we have to process.
    preprocess(globParts) {
        // if we're not in globstar mode, then turn ** into *
        if (this.options.noglobstar) {
            for (const partset of globParts) {
                for (let j = 0; j < partset.length; j++) {
                    if (partset[j] === '**') {
                        partset[j] = '*';
                    }
                }
            }
        }
        const { optimizationLevel = 1 } = this.options;
        if (optimizationLevel >= 2) {
            // aggressive optimization for the purpose of fs walking
            globParts = this.firstPhasePreProcess(globParts);
            globParts = this.secondPhasePreProcess(globParts);
        }
        else if (optimizationLevel >= 1) {
            // just basic optimizations to remove some .. parts
            globParts = this.levelOneOptimize(globParts);
        }
        else {
            // just collapse multiple ** portions into one
            globParts = this.adjascentGlobstarOptimize(globParts);
        }
        return globParts;
    }
    // just get rid of adjascent ** portions
    adjascentGlobstarOptimize(globParts) {
        return globParts.map(parts => {
            let gs = -1;
            while (-1 !== (gs = parts.indexOf('**', gs + 1))) {
                let i = gs;
                while (parts[i + 1] === '**') {
                    i++;
                }
                if (i !== gs) {
                    parts.splice(gs, i - gs);
                }
            }
            return parts;
        });
    }
    // get rid of adjascent ** and resolve .. portions
    levelOneOptimize(globParts) {
        return globParts.map(parts => {
            parts = parts.reduce((set, part) => {
                const prev = set[set.length - 1];
                if (part === '**' && prev === '**') {
                    return set;
                }
                if (part === '..') {
                    if (prev && prev !== '..' && prev !== '.' && prev !== '**') {
                        set.pop();
                        return set;
                    }
                }
                set.push(part);
                return set;
            }, []);
            return parts.length === 0 ? [''] : parts;
        });
    }
    levelTwoFileOptimize(parts) {
        if (!Array.isArray(parts)) {
            parts = this.slashSplit(parts);
        }
        let didSomething = false;
        do {
            didSomething = false;
            // <pre>/<e>/<rest> -> <pre>/<rest>
            if (!this.preserveMultipleSlashes) {
                for (let i = 1; i < parts.length - 1; i++) {
                    const p = parts[i];
                    // don't squeeze out UNC patterns
                    if (i === 1 && p === '' && parts[0] === '')
                        continue;
                    if (p === '.' || p === '') {
                        didSomething = true;
                        parts.splice(i, 1);
                        i--;
                    }
                }
                if (parts[0] === '.' &&
                    parts.length === 2 &&
                    (parts[1] === '.' || parts[1] === '')) {
                    didSomething = true;
                    parts.pop();
                }
            }
            // <pre>/<p>/../<rest> -> <pre>/<rest>
            let dd = 0;
            while (-1 !== (dd = parts.indexOf('..', dd + 1))) {
                const p = parts[dd - 1];
                if (p &&
                    p !== '.' &&
                    p !== '..' &&
                    p !== '**' &&
                    !(this.isWindows && /^[a-z]:$/i.test(p))) {
                    didSomething = true;
                    parts.splice(dd - 1, 2);
                    dd -= 2;
                }
            }
        } while (didSomething);
        return parts.length === 0 ? [''] : parts;
    }
    // First phase: single-pattern processing
    // <pre> is 1 or more portions
    // <rest> is 1 or more portions
    // <p> is any portion other than ., .., '', or **
    // <e> is . or ''
    //
    // **/.. is *brutal* for filesystem walking performance, because
    // it effectively resets the recursive walk each time it occurs,
    // and ** cannot be reduced out by a .. pattern part like a regexp
    // or most strings (other than .., ., and '') can be.
    //
    // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
    // <pre>/<e>/<rest> -> <pre>/<rest>
    // <pre>/<p>/../<rest> -> <pre>/<rest>
    // **/**/<rest> -> **/<rest>
    //
    // **/*/<rest> -> */**/<rest> <== not valid because ** doesn't follow
    // this WOULD be allowed if ** did follow symlinks, or * didn't
    firstPhasePreProcess(globParts) {
        let didSomething = false;
        do {
            didSomething = false;
            // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
            for (let parts of globParts) {
                let gs = -1;
                while (-1 !== (gs = parts.indexOf('**', gs + 1))) {
                    let gss = gs;
                    while (parts[gss + 1] === '**') {
                        // <pre>/**/**/<rest> -> <pre>/**/<rest>
                        gss++;
                    }
                    // eg, if gs is 2 and gss is 4, that means we have 3 **
                    // parts, and can remove 2 of them.
                    if (gss > gs) {
                        parts.splice(gs + 1, gss - gs);
                    }
                    let next = parts[gs + 1];
                    const p = parts[gs + 2];
                    const p2 = parts[gs + 3];
                    if (next !== '..')
                        continue;
                    if (!p ||
                        p === '.' ||
                        p === '..' ||
                        !p2 ||
                        p2 === '.' ||
                        p2 === '..') {
                        continue;
                    }
                    didSomething = true;
                    // edit parts in place, and push the new one
                    parts.splice(gs, 1);
                    const other = parts.slice(0);
                    other[gs] = '**';
                    globParts.push(other);
                    gs--;
                }
                // <pre>/<e>/<rest> -> <pre>/<rest>
                if (!this.preserveMultipleSlashes) {
                    for (let i = 1; i < parts.length - 1; i++) {
                        const p = parts[i];
                        // don't squeeze out UNC patterns
                        if (i === 1 && p === '' && parts[0] === '')
                            continue;
                        if (p === '.' || p === '') {
                            didSomething = true;
                            parts.splice(i, 1);
                            i--;
                        }
                    }
                    if (parts[0] === '.' &&
                        parts.length === 2 &&
                        (parts[1] === '.' || parts[1] === '')) {
                        didSomething = true;
                        parts.pop();
                    }
                }
                // <pre>/<p>/../<rest> -> <pre>/<rest>
                let dd = 0;
                while (-1 !== (dd = parts.indexOf('..', dd + 1))) {
                    const p = parts[dd - 1];
                    if (p && p !== '.' && p !== '..' && p !== '**') {
                        didSomething = true;
                        const needDot = dd === 1 && parts[dd + 1] === '**';
                        const splin = needDot ? ['.'] : [];
                        parts.splice(dd - 1, 2, ...splin);
                        if (parts.length === 0)
                            parts.push('');
                        dd -= 2;
                    }
                }
            }
        } while (didSomething);
        return globParts;
    }
    // second phase: multi-pattern dedupes
    // {<pre>/*/<rest>,<pre>/<p>/<rest>} -> <pre>/*/<rest>
    // {<pre>/<rest>,<pre>/<rest>} -> <pre>/<rest>
    // {<pre>/**/<rest>,<pre>/<rest>} -> <pre>/**/<rest>
    //
    // {<pre>/**/<rest>,<pre>/**/<p>/<rest>} -> <pre>/**/<rest>
    // ^-- not valid because ** doens't follow symlinks
    secondPhasePreProcess(globParts) {
        for (let i = 0; i < globParts.length - 1; i++) {
            for (let j = i + 1; j < globParts.length; j++) {
                const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
                if (matched) {
                    globParts[i] = [];
                    globParts[j] = matched;
                    break;
                }
            }
        }
        return globParts.filter(gs => gs.length);
    }
    partsMatch(a, b, emptyGSMatch = false) {
        let ai = 0;
        let bi = 0;
        let result = [];
        let which = '';
        while (ai < a.length && bi < b.length) {
            if (a[ai] === b[bi]) {
                result.push(which === 'b' ? b[bi] : a[ai]);
                ai++;
                bi++;
            }
            else if (emptyGSMatch && a[ai] === '**' && b[bi] === a[ai + 1]) {
                result.push(a[ai]);
                ai++;
            }
            else if (emptyGSMatch && b[bi] === '**' && a[ai] === b[bi + 1]) {
                result.push(b[bi]);
                bi++;
            }
            else if (a[ai] === '*' &&
                b[bi] &&
                (this.options.dot || !b[bi].startsWith('.')) &&
                b[bi] !== '**') {
                if (which === 'b')
                    return false;
                which = 'a';
                result.push(a[ai]);
                ai++;
                bi++;
            }
            else if (b[bi] === '*' &&
                a[ai] &&
                (this.options.dot || !a[ai].startsWith('.')) &&
                a[ai] !== '**') {
                if (which === 'a')
                    return false;
                which = 'b';
                result.push(b[bi]);
                ai++;
                bi++;
            }
            else {
                return false;
            }
        }
        // if we fall out of the loop, it means they two are identical
        // as long as their lengths match
        return a.length === b.length && result;
    }
    parseNegate() {
        if (this.nonegate)
            return;
        const pattern = this.pattern;
        let negate = false;
        let negateOffset = 0;
        for (let i = 0; i < pattern.length && pattern.charAt(i) === '!'; i++) {
            negate = !negate;
            negateOffset++;
        }
        if (negateOffset)
            this.pattern = pattern.slice(negateOffset);
        this.negate = negate;
    }
    // set partial to true to test if, for example,
    // "/a/b" matches the start of "/*/b/*/d"
    // Partial means, if you run out of file before you run
    // out of pattern, then that's fine, as long as all
    // the parts match.
    matchOne(file, pattern, partial = false) {
        let fileStartIndex = 0;
        let patternStartIndex = 0;
        // UNC paths like //?/X:/... can match X:/... and vice versa
        // Drive letters in absolute drive or unc paths are always compared
        // case-insensitively.
        if (this.isWindows) {
            const fileDrive = typeof file[0] === 'string' && /^[a-z]:$/i.test(file[0]);
            const fileUNC = !fileDrive &&
                file[0] === '' &&
                file[1] === '' &&
                file[2] === '?' &&
                /^[a-z]:$/i.test(file[3]);
            const patternDrive = typeof pattern[0] === 'string' && /^[a-z]:$/i.test(pattern[0]);
            const patternUNC = !patternDrive &&
                pattern[0] === '' &&
                pattern[1] === '' &&
                pattern[2] === '?' &&
                typeof pattern[3] === 'string' &&
                /^[a-z]:$/i.test(pattern[3]);
            const fdi = fileUNC ? 3
                : fileDrive ? 0
                    : undefined;
            const pdi = patternUNC ? 3
                : patternDrive ? 0
                    : undefined;
            if (typeof fdi === 'number' && typeof pdi === 'number') {
                const [fd, pd] = [
                    file[fdi],
                    pattern[pdi],
                ];
                // start matching at the drive letter index of each
                if (fd.toLowerCase() === pd.toLowerCase()) {
                    pattern[pdi] = fd;
                    patternStartIndex = pdi;
                    fileStartIndex = fdi;
                }
            }
        }
        // resolve and reduce . and .. portions in the file as well.
        // don't need to do the second phase, because it's only one string[]
        const { optimizationLevel = 1 } = this.options;
        if (optimizationLevel >= 2) {
            file = this.levelTwoFileOptimize(file);
        }
        if (pattern.includes(exports.GLOBSTAR)) {
            return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
        }
        return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
    }
    #matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
        // split the pattern into head, tail, and middle of ** delimited parts
        const firstgs = pattern.indexOf(exports.GLOBSTAR, patternIndex);
        const lastgs = pattern.lastIndexOf(exports.GLOBSTAR);
        // split the pattern up into globstar-delimited sections
        // the tail has to be at the end, and the others just have
        // to be found in order from the head.
        const [head, body, tail] = partial ?
            [
                pattern.slice(patternIndex, firstgs),
                pattern.slice(firstgs + 1),
                [],
            ]
            : [
                pattern.slice(patternIndex, firstgs),
                pattern.slice(firstgs + 1, lastgs),
                pattern.slice(lastgs + 1),
            ];
        // check the head, from the current file/pattern index.
        if (head.length) {
            const fileHead = file.slice(fileIndex, fileIndex + head.length);
            if (!this.#matchOne(fileHead, head, partial, 0, 0)) {
                return false;
            }
            fileIndex += head.length;
            patternIndex += head.length;
        }
        // now we know the head matches!
        // if the last portion is not empty, it MUST match the end
        // check the tail
        let fileTailMatch = 0;
        if (tail.length) {
            // if head + tail > file, then we cannot possibly match
            if (tail.length + fileIndex > file.length)
                return false;
            // try to match the tail
            let tailStart = file.length - tail.length;
            if (this.#matchOne(file, tail, partial, tailStart, 0)) {
                fileTailMatch = tail.length;
            }
            else {
                // affordance for stuff like a/**/* matching a/b/
                // if the last file portion is '', and there's more to the pattern
                // then try without the '' bit.
                if (file[file.length - 1] !== '' ||
                    fileIndex + tail.length === file.length) {
                    return false;
                }
                tailStart--;
                if (!this.#matchOne(file, tail, partial, tailStart, 0)) {
                    return false;
                }
                fileTailMatch = tail.length + 1;
            }
        }
        // now we know the tail matches!
        // the middle is zero or more portions wrapped in **, possibly
        // containing more ** sections.
        // so a/**/b/**/c/**/d has become **/b/**/c/**
        // if it's empty, it means a/**/b, just verify we have no bad dots
        // if there's no tail, so it ends on /**, then we must have *something*
        // after the head, or it's not a matc
        if (!body.length) {
            let sawSome = !!fileTailMatch;
            for (let i = fileIndex; i < file.length - fileTailMatch; i++) {
                const f = String(file[i]);
                sawSome = true;
                if (f === '.' ||
                    f === '..' ||
                    (!this.options.dot && f.startsWith('.'))) {
                    return false;
                }
            }
            // in partial mode, we just need to get past all file parts
            return partial || sawSome;
        }
        // now we know that there's one or more body sections, which can
        // be matched anywhere from the 0 index (because the head was pruned)
        // through to the length-fileTailMatch index.
        // split the body up into sections, and note the minimum index it can
        // be found at (start with the length of all previous segments)
        // [section, before, after]
        const bodySegments = [[[], 0]];
        let currentBody = bodySegments[0];
        let nonGsParts = 0;
        const nonGsPartsSums = [0];
        for (const b of body) {
            if (b === exports.GLOBSTAR) {
                nonGsPartsSums.push(nonGsParts);
                currentBody = [[], 0];
                bodySegments.push(currentBody);
            }
            else {
                currentBody[0].push(b);
                nonGsParts++;
            }
        }
        let i = bodySegments.length - 1;
        const fileLength = file.length - fileTailMatch;
        for (const b of bodySegments) {
            b[1] = fileLength - (nonGsPartsSums[i--] + b[0].length);
        }
        return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
    }
    // return false for "nope, not matching"
    // return null for "not matching, cannot keep trying"
    #matchGlobStarBodySections(file, 
    // pattern section, last possible position for it
    bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
        // take the first body segment, and walk from fileIndex to its "after"
        // value at the end
        // If it doesn't match at that position, we increment, until we hit
        // that final possible position, and give up.
        // If it does match, then advance and try to rest.
        // If any of them fail we keep walking forward.
        // this is still a bit recursively painful, but it's more constrained
        // than previous implementations, because we never test something that
        // can't possibly be a valid matching condition.
        const bs = bodySegments[bodyIndex];
        if (!bs) {
            // just make sure that there's no bad dots
            for (let i = fileIndex; i < file.length; i++) {
                sawTail = true;
                const f = file[i];
                if (f === '.' ||
                    f === '..' ||
                    (!this.options.dot && f.startsWith('.'))) {
                    return false;
                }
            }
            return sawTail;
        }
        // have a non-globstar body section to test
        const [body, after] = bs;
        while (fileIndex <= after) {
            const m = this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0);
            // if limit exceeded, no match. intentional false negative,
            // acceptable break in correctness for security.
            if (m && globStarDepth < this.maxGlobstarRecursion) {
                // match! see if the rest match. if so, we're done!
                const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
                if (sub !== false) {
                    return sub;
                }
            }
            const f = file[fileIndex];
            if (f === '.' ||
                f === '..' ||
                (!this.options.dot && f.startsWith('.'))) {
                return false;
            }
            fileIndex++;
        }
        // walked off. no point continuing
        return partial || null;
    }
    #matchOne(file, pattern, partial, fileIndex, patternIndex) {
        let fi;
        let pi;
        let pl;
        let fl;
        for (fi = fileIndex,
            pi = patternIndex,
            fl = file.length,
            pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
            this.debug('matchOne loop');
            let p = pattern[pi];
            let f = file[fi];
            this.debug(pattern, p, f);
            // should be impossible.
            // some invalid regexp stuff in the set.
            /* c8 ignore start */
            if (p === false || p === exports.GLOBSTAR) {
                return false;
            }
            /* c8 ignore stop */
            // something other than **
            // non-magic patterns just have to match exactly
            // patterns with magic have been turned into regexps.
            let hit;
            if (typeof p === 'string') {
                hit = f === p;
                this.debug('string match', p, f, hit);
            }
            else {
                hit = p.test(f);
                this.debug('pattern match', p, f, hit);
            }
            if (!hit)
                return false;
        }
        // Note: ending in / means that we'll get a final ""
        // at the end of the pattern.  This can only match a
        // corresponding "" at the end of the file.
        // If the file ends in /, then it can only match a
        // a pattern that ends in /, unless the pattern just
        // doesn't have any more for it. But, a/b/ should *not*
        // match "a/b/*", even though "" matches against the
        // [^/]*? pattern, except in partial mode, where it might
        // simply not be reached yet.
        // However, a/b/ should still satisfy a/*
        // now either we fell off the end of the pattern, or we're done.
        if (fi === fl && pi === pl) {
            // ran out of pattern and filename at the same time.
            // an exact hit!
            return true;
        }
        else if (fi === fl) {
            // ran out of file, but still had pattern left.
            // this is ok if we're doing the match as part of
            // a glob fs traversal.
            return partial;
        }
        else if (pi === pl) {
            // ran out of pattern, still have file left.
            // this is only acceptable if we're on the very last
            // empty segment of a file with a trailing slash.
            // a/* should match a/b/
            return fi === fl - 1 && file[fi] === '';
            /* c8 ignore start */
        }
        else {
            // should be unreachable.
            throw new Error('wtf?');
        }
        /* c8 ignore stop */
    }
    braceExpand() {
        return (0, exports.braceExpand)(this.pattern, this.options);
    }
    parse(pattern) {
        (0, assert_valid_pattern_js_1.assertValidPattern)(pattern);
        const options = this.options;
        // shortcuts
        if (pattern === '**')
            return exports.GLOBSTAR;
        if (pattern === '')
            return '';
        // far and away, the most common glob pattern parts are
        // *, *.*, and *.<ext>  Add a fast check method for those.
        let m;
        let fastTest = null;
        if ((m = pattern.match(starRE))) {
            fastTest = options.dot ? starTestDot : starTest;
        }
        else if ((m = pattern.match(starDotExtRE))) {
            fastTest = (options.nocase ?
                options.dot ?
                    starDotExtTestNocaseDot
                    : starDotExtTestNocase
                : options.dot ? starDotExtTestDot
                    : starDotExtTest)(m[1]);
        }
        else if ((m = pattern.match(qmarksRE))) {
            fastTest = (options.nocase ?
                options.dot ?
                    qmarksTestNocaseDot
                    : qmarksTestNocase
                : options.dot ? qmarksTestDot
                    : qmarksTest)(m);
        }
        else if ((m = pattern.match(starDotStarRE))) {
            fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
        }
        else if ((m = pattern.match(dotStarRE))) {
            fastTest = dotStarTest;
        }
        const re = ast_js_1.AST.fromGlob(pattern, this.options).toMMPattern();
        if (fastTest && typeof re === 'object') {
            // Avoids overriding in frozen environments
            Reflect.defineProperty(re, 'test', { value: fastTest });
        }
        return re;
    }
    makeRe() {
        if (this.regexp || this.regexp === false)
            return this.regexp;
        // at this point, this.set is a 2d array of partial
        // pattern strings, or "**".
        //
        // It's better to use .match().  This function shouldn't
        // be used, really, but it's pretty convenient sometimes,
        // when you just want to work with a regex.
        const set = this.set;
        if (!set.length) {
            this.regexp = false;
            return this.regexp;
        }
        const options = this.options;
        const twoStar = options.noglobstar ? star
            : options.dot ? twoStarDot
                : twoStarNoDot;
        const flags = new Set(options.nocase ? ['i'] : []);
        // regexpify non-globstar patterns
        // if ** is only item, then we just do one twoStar
        // if ** is first, and there are more, prepend (\/|twoStar\/)? to next
        // if ** is last, append (\/twoStar|) to previous
        // if ** is in the middle, append (\/|\/twoStar\/) to previous
        // then filter out GLOBSTAR symbols
        let re = set
            .map(pattern => {
            const pp = pattern.map(p => {
                if (p instanceof RegExp) {
                    for (const f of p.flags.split(''))
                        flags.add(f);
                }
                return (typeof p === 'string' ? regExpEscape(p)
                    : p === exports.GLOBSTAR ? exports.GLOBSTAR
                        : p._src);
            });
            pp.forEach((p, i) => {
                const next = pp[i + 1];
                const prev = pp[i - 1];
                if (p !== exports.GLOBSTAR || prev === exports.GLOBSTAR) {
                    return;
                }
                if (prev === undefined) {
                    if (next !== undefined && next !== exports.GLOBSTAR) {
                        pp[i + 1] = '(?:\\/|' + twoStar + '\\/)?' + next;
                    }
                    else {
                        pp[i] = twoStar;
                    }
                }
                else if (next === undefined) {
                    pp[i - 1] = prev + '(?:\\/|\\/' + twoStar + ')?';
                }
                else if (next !== exports.GLOBSTAR) {
                    pp[i - 1] = prev + '(?:\\/|\\/' + twoStar + '\\/)' + next;
                    pp[i + 1] = exports.GLOBSTAR;
                }
            });
            const filtered = pp.filter(p => p !== exports.GLOBSTAR);
            // For partial matches, we need to make the pattern match
            // any prefix of the full path. We do this by generating
            // alternative patterns that match progressively longer prefixes.
            if (this.partial && filtered.length >= 1) {
                const prefixes = [];
                for (let i = 1; i <= filtered.length; i++) {
                    prefixes.push(filtered.slice(0, i).join('/'));
                }
                return '(?:' + prefixes.join('|') + ')';
            }
            return filtered.join('/');
        })
            .join('|');
        // need to wrap in parens if we had more than one thing with |,
        // otherwise only the first will be anchored to ^ and the last to $
        const [open, close] = set.length > 1 ? ['(?:', ')'] : ['', ''];
        // must match entire pattern
        // ending in a * or ** will make it less strict.
        re = '^' + open + re + close + '$';
        // In partial mode, '/' should always match as it's a valid prefix for any pattern
        if (this.partial) {
            re = '^(?:\\/|' + open + re.slice(1, -1) + close + ')$';
        }
        // can match anything, as long as it's not this.
        if (this.negate)
            re = '^(?!' + re + ').+$';
        try {
            this.regexp = new RegExp(re, [...flags].join(''));
            /* c8 ignore start */
        }
        catch {
            // should be impossible
            this.regexp = false;
        }
        /* c8 ignore stop */
        return this.regexp;
    }
    slashSplit(p) {
        // if p starts with // on windows, we preserve that
        // so that UNC paths aren't broken.  Otherwise, any number of
        // / characters are coalesced into one, unless
        // preserveMultipleSlashes is set to true.
        if (this.preserveMultipleSlashes) {
            return p.split('/');
        }
        else if (this.isWindows && /^\/\/[^/]+/.test(p)) {
            // add an extra '' for the one we lose
            return ['', ...p.split(/\/+/)];
        }
        else {
            return p.split(/\/+/);
        }
    }
    match(f, partial = this.partial) {
        this.debug('match', f, this.pattern);
        // short-circuit in the case of busted things.
        // comments, etc.
        if (this.comment) {
            return false;
        }
        if (this.empty) {
            return f === '';
        }
        if (f === '/' && partial) {
            return true;
        }
        const options = this.options;
        // windows: need to use /, not \
        if (this.isWindows) {
            f = f.split('\\').join('/');
        }
        // treat the test path as a set of pathparts.
        const ff = this.slashSplit(f);
        this.debug(this.pattern, 'split', ff);
        // just ONE of the pattern sets in this.set needs to match
        // in order for it to be valid.  If negating, then just one
        // match means that we have failed.
        // Either way, return on the first hit.
        const set = this.set;
        this.debug(this.pattern, 'set', set);
        // Find the basename of the path by looking for the last non-empty segment
        let filename = ff[ff.length - 1];
        if (!filename) {
            for (let i = ff.length - 2; !filename && i >= 0; i--) {
                filename = ff[i];
            }
        }
        for (const pattern of set) {
            let file = ff;
            if (options.matchBase && pattern.length === 1) {
                file = [filename];
            }
            const hit = this.matchOne(file, pattern, partial);
            if (hit) {
                if (options.flipNegate) {
                    return true;
                }
                return !this.negate;
            }
        }
        // didn't get any hits.  this is success if it's a negative
        // pattern, failure otherwise.
        if (options.flipNegate) {
            return false;
        }
        return this.negate;
    }
    static defaults(def) {
        return exports.minimatch.defaults(def).Minimatch;
    }
}
exports.Minimatch = Minimatch;
/* c8 ignore start */
var ast_js_2 = __nccwpck_require__(803);
Object.defineProperty(exports, "AST", ({ enumerable: true, get: function () { return ast_js_2.AST; } }));
var escape_js_2 = __nccwpck_require__(800);
Object.defineProperty(exports, "escape", ({ enumerable: true, get: function () { return escape_js_2.escape; } }));
var unescape_js_2 = __nccwpck_require__(851);
Object.defineProperty(exports, "unescape", ({ enumerable: true, get: function () { return unescape_js_2.unescape; } }));
/* c8 ignore stop */
exports.minimatch.AST = ast_js_1.AST;
exports.minimatch.Minimatch = Minimatch;
exports.minimatch.escape = escape_js_1.escape;
exports.minimatch.unescape = unescape_js_1.unescape;
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 851:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.unescape = void 0;
/**
 * Un-escape a string that has been escaped with {@link escape}.
 *
 * If the {@link MinimatchOptions.windowsPathsNoEscape} option is used, then
 * square-bracket escapes are removed, but not backslash escapes.
 *
 * For example, it will turn the string `'[*]'` into `*`, but it will not
 * turn `'\\*'` into `'*'`, because `\` is a path separator in
 * `windowsPathsNoEscape` mode.
 *
 * When `windowsPathsNoEscape` is not set, then both square-bracket escapes and
 * backslash escapes are removed.
 *
 * Slashes (and backslashes in `windowsPathsNoEscape` mode) cannot be escaped
 * or unescaped.
 *
 * When `magicalBraces` is not set, escapes of braces (`{` and `}`) will not be
 * unescaped.
 */
const unescape = (s, { windowsPathsNoEscape = false, magicalBraces = true, } = {}) => {
    if (magicalBraces) {
        return windowsPathsNoEscape ?
            s.replace(/\[([^/\\])\]/g, '$1')
            : s
                .replace(/((?!\\).|^)\[([^/\\])\]/g, '$1$2')
                .replace(/\\([^/])/g, '$1');
    }
    return windowsPathsNoEscape ?
        s.replace(/\[([^/\\{}])\]/g, '$1')
        : s
            .replace(/((?!\\).|^)\[([^/\\{}])\]/g, '$1$2')
            .replace(/\\([^/{}])/g, '$1');
};
exports.unescape = unescape;
//# sourceMappingURL=unescape.js.map

/***/ }),

/***/ 330:
/***/ ((module) => {

module.exports = /*#__PURE__*/JSON.parse('{"name":"catchmydrift","version":"0.1.0","description":"Checks watched files for drift against related Git-tracked changes","main":"index.js","files":["index.js","lib","catchmydrift.schema.json","catchmydrift-state.schema.json","CHANGELOG.md","README.md"],"scripts":{"test":"node --test","changeset":"changeset","release:version":"changeset version && npm install --package-lock-only --ignore-scripts --no-audit --no-fund","release":"changeset publish","build:action":"node -e \\"require(\'node:fs\').rmSync(\'dist\', { recursive: true, force: true })\\" && ncc build action/main.js -o dist --license licenses.txt"},"author":"Patrick McElhaney","license":"ISC","repository":{"type":"git","url":"git+https://github.com/pmcelhaney/catchmydrift.git"},"bugs":{"url":"https://github.com/pmcelhaney/catchmydrift/issues"},"homepage":"https://github.com/pmcelhaney/catchmydrift#readme","bin":{"catchmydrift":"./index.js"},"engines":{"node":">=22"},"dependencies":{"minimatch":"10.2.6"},"devDependencies":{"@changesets/cli":"3.0.3","@vercel/ncc":"0.45.0","ajv":"8.20.0"}}');

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/asset-relocator-loader */
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __nccwpck_require__(422);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;