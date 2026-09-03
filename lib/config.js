'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Minimatch, unescape } = require('minimatch');
const {
  OperationalError,
  comparePaths,
  isStatePath,
  isWithin
} = require('./git');

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
  const threshold = value.threshold === undefined ? 0 : validateThreshold(value.threshold, 'Configuration threshold');
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

function relationshipSignature(definition) {
  return crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');
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
      relationshipDefinition,
      relationship: relationshipSignature(relationshipDefinition)
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
  relationshipSignature,
  matchesConfiguredRelationship,
  literalPathForPattern,
  assertWildcardPatternsResolve,
  resolveConfiguredWatch
};
