const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const configurationSchema = require('../catchmydrift.schema.json');
const { normalizeConfig } = require('../lib/config');

const cliEntryPoint = path.resolve(__dirname, '..', 'index.js');

function runGit(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

function writeFile(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeConfig(repository, config, relativePath = 'catchmydrift.config.json') {
  writeFile(repository, relativePath, typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`);
}

function createRepository(t, files = {}) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'catchmydrift-config-test-'));
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'catchmydrift config test']);
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(repository, relativePath, contents);
  }
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '--quiet', '-m', 'initial fixture']);
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  return repository;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliEntryPoint, ...args], { cwd, encoding: 'utf8' });
}

function assertStatus(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

function baseConfig(overrides = {}) {
  return {
    groups: {
      related: { include: ['source/**'] }
    },
    watch: [
      { include: ['docs/guide.md'], groups: ['related'] }
    ],
    ...overrides
  };
}

function configuredWatchFixture(t) {
  const config = baseConfig();
  return createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'unchanged\n'
  });
}

test('a present default configuration replaces zero-config Markdown discovery', t => {
  const config = {
    groups: { related: { include: ['source/**'] } },
    watch: [{ include: ['notes/instructions.txt'], groups: ['related'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'README.md': '# Root\n',
    'docs/guide.md': '# Guide\n',
    'docs/changed.txt': 'before\n',
    'notes/instructions.txt': 'keep this current\n',
    'source/service.js': 'unchanged\n'
  });

  writeFile(repository, 'docs/changed.txt', 'after\n');
  const result = runCli([], repository);

  assertStatus(result, 0);
  assert.doesNotMatch(result.stdout, /README\.md|guide\.md/);
  assert.match(result.stdout, /1 watched file checked/i);
});

test('named POSIX glob groups include dotfiles, exclude matches, and watch arbitrary file types', t => {
  const config = {
    groups: {
      documentation: {
        include: ['docs/**'],
        exclude: ['docs/ignored/**']
      }
    },
    watch: [
      { include: ['docs/**/guide.md'], groups: ['documentation'] },
      { include: ['scripts/**/manual.txt'], groups: ['documentation'] }
    ]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'docs/.private/guide.md': '# Private guide\n',
    'docs/.private/service.txt': 'before\n',
    'docs/ignored/not-counted.txt': 'before\n',
    'scripts/ops/manual.txt': 'Run safely.\n'
  });

  writeFile(repository, 'docs/.private/service.txt', 'after\n');
  writeFile(repository, 'docs/ignored/not-counted.txt', 'after\n');
  const result = runCli([], repository);

  assertStatus(result, 1);
  assert.match(result.stdout, /docs\/\.private\/guide\.md/);
  assert.match(result.stdout, /scripts\/ops\/manual\.txt/);
  assert.doesNotMatch(result.stdout, /not-counted\.txt/);
});

test('group unions are deduplicated before drift is measured', t => {
  const config = {
    groups: {
      first: { include: ['source/service.txt'] },
      second: { include: ['source/service.txt'] }
    },
    watch: [{ include: ['docs/guide.md'], groups: ['first', 'second'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'old\nstable\n'
  });

  writeFile(repository, 'source/service.txt', 'new\nstable\n');
  const result = runCli([], repository);

  assertStatus(result, 1);
  assert.match(result.stdout, /100\.00%.*guide\.md/);
});

test('configured groups exclude the state file even when its literal path is selected', t => {
  const config = {
    groups: { state: { include: ['.catchmydrift-state.json', 'docs/source.txt'] } },
    watch: [{ include: ['docs/guide.md'], groups: ['state'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    '.catchmydrift-state.json': '{"version":1,"reviews":{}}\n',
    'docs/guide.md': '# Guide\n',
    'docs/source.txt': 'unchanged\n'
  });

  writeFile(repository, '.catchmydrift-state.json', '{\n  "version": 1,\n  "reviews": {}\n}\n');
  const result = runCli([], repository);

  assertStatus(result, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /catchmydrift-state/);
});

test('the configuration file can be both a watched file and a related file', t => {
  const config = {
    groups: { configuration: { include: ['catchmydrift.config.json'] } },
    watch: [{ include: ['catchmydrift.config.json'], groups: ['configuration'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config, null, 2)}\n`
  });

  writeFile(repository, 'catchmydrift.config.json', `${JSON.stringify(config, null, 2)}\n\n\n\n\n\n`);
  const result = runCli([], repository);

  assertStatus(result, 1);
  assert.match(result.stdout, /catchmydrift\.config\.json/);
});

test('threshold precedence is command line, then watch rule, then top-level configuration, then the default of 20', t => {
  const ruleThreshold = baseConfig({ threshold: 0 });
  ruleThreshold.watch[0].threshold = 100;
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(ruleThreshold)}\n`,
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'before\nstable\n'
  });
  writeFile(repository, 'source/service.txt', 'after\nstable\n');

  const ruleWins = runCli([], repository);
  const commandLineWins = runCli(['--threshold', '0'], repository);

  assertStatus(ruleWins, 0);
  assertStatus(commandLineWins, 1);
  assert.match(commandLineWins.stdout, /threshold 0\.00%/);

  const topLevelConfig = baseConfig({ threshold: 100 });
  writeConfig(repository, topLevelConfig);
  const topLevelWins = runCli([], repository);
  assertStatus(topLevelWins, 0);

  delete topLevelConfig.threshold;
  writeConfig(repository, topLevelConfig);
  const implicitDefault = runCli([], repository);
  assertStatus(implicitDefault, 1);
  assert.match(implicitDefault.stdout, /threshold 20\.00%/);
});

test('an exact missing watched literal is unhealthy while an unmatched watched wildcard is a configuration error', t => {
  const missingLiteral = baseConfig({
    watch: [{ include: ['docs/missing.md'], groups: ['related'] }]
  });
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(missingLiteral)}\n`,
    'source/service.txt': 'service\n'
  });

  const literalResult = runCli([], repository);
  assertStatus(literalResult, 1);
  assert.match(literalResult.stdout, /missing: docs\/missing\.md/);

  writeConfig(repository, baseConfig({
    watch: [{ include: ['docs/*.md'], groups: ['related'] }]
  }));
  const wildcardResult = runCli([], repository);
  assertStatus(wildcardResult, 2);
});

test('empty, unknown, and no-match groups are rejected as configuration errors', t => {
  const repository = createRepository(t, {
    'catchmydrift.config.json': '{}\n',
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'service\n'
  });

  const cases = [
    {
      groups: { related: { include: ['source/**'] } },
      watch: [{ include: ['docs/guide.md'], groups: [] }]
    },
    {
      groups: { empty: { include: ['does-not-exist/**'] } },
      watch: [{ include: ['docs/guide.md'], groups: ['empty'] }]
    },
    {
      groups: { related: { include: ['source/**'] } },
      watch: [{ include: ['docs/guide.md'], groups: ['unknown'] }]
    }
  ];

  for (const config of cases) {
    writeConfig(repository, config);
    assertStatus(runCli([], repository), 2);
  }
});

test('malformed JSON, invalid schema shapes and percentages, and overlapping watches exit 2', t => {
  const repository = createRepository(t, {
    'catchmydrift.config.json': '{}\n',
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'service\n'
  });
  const invalidConfigurations = [
    '{ this is not JSON',
    { groups: [], watch: [] },
    { groups: { related: { include: [] } }, watch: [] },
    { groups: { related: { include: ['source/**'] } }, watch: [{ include: ['docs/guide.md'], groups: ['related'], threshold: 101 }] },
    { groups: { related: { include: ['source/**'] } }, watch: [{ include: ['docs/guide.md'], groups: ['related'], threshold: '50' }] },
    {
      groups: { related: { include: ['source/**'] } },
      watch: [
        { include: ['docs/guide.md'], groups: ['related'] },
        { include: ['docs/guide.md'], groups: ['related'] }
      ]
    }
  ];

  for (const config of invalidConfigurations) {
    writeConfig(repository, config);
    assertStatus(runCli([], repository), 2);
  }
});

test('absolute and escaping configuration globs are rejected', t => {
  const repository = createRepository(t, {
    'catchmydrift.config.json': '{}\n',
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'service\n'
  });
  const invalidConfigurations = [
    baseConfig({ groups: { related: { include: ['../source/**'] } } }),
    baseConfig({ groups: { related: { include: [path.join(repository, 'source/**')] } } }),
    baseConfig({ watch: [{ include: ['../docs/guide.md'], groups: ['related'] }] }),
    baseConfig({ watch: [{ include: [path.join(repository, 'docs/guide.md')], groups: ['related'] }] })
  ];

  for (const config of invalidConfigurations) {
    writeConfig(repository, config);
    assertStatus(runCli([], repository), 2);
  }
});

test('custom configuration is contained by the selected root and its globs are relative to that root', t => {
  const config = {
    groups: { related: { include: ['source/service.txt'] } },
    watch: [{ include: ['README.md'], groups: ['related'] }]
  };
  const repository = createRepository(t, {
    'selected/config/custom.json': `${JSON.stringify(config)}\n`,
    'selected/README.md': '# Selected\n',
    'selected/source/service.txt': 'before\n',
    'outside.json': `${JSON.stringify(config)}\n`
  });
  writeFile(repository, 'selected/source/service.txt', 'after\n');

  const result = runCli(['selected', '--config', 'selected/config/custom.json'], repository);
  assertStatus(result, 1);
  assert.match(result.stdout, /README\.md/);
  assert.doesNotMatch(result.stdout, /selected\/README\.md/);

  assertStatus(runCli(['selected', '--config', 'outside.json'], repository), 2);
  assertStatus(runCli(['selected', '--config', '../outside.json'], repository), 2);
});

test('glob metacharacters are interpreted by configuration matching while literal matched paths remain safe', t => {
  const config = {
    groups: { related: { include: ['source/service.txt'] } },
    watch: [{ include: ['docs/[guide].md'], groups: ['related'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'docs/g.md': '# Matched by glob\n',
    'docs/[guide].md': '# Literal brackets\n',
    'source/service.txt': 'before\n'
  });
  writeFile(repository, 'source/service.txt', 'after\n');

  const result = runCli([], repository);
  assertStatus(result, 1);
  assert.match(result.stdout, /docs\/g\.md/);
  assert.doesNotMatch(result.stdout, /\[guide\]\.md/);

  writeConfig(repository, {
    groups: { related: { include: ['source/service.txt'] } },
    watch: [{ include: ['docs/\\[guide\\].md'], groups: ['related'] }]
  });
  const literalResult = runCli([], repository);
  assertStatus(literalResult, 1);
  assert.match(literalResult.stdout, /\[guide\]\.md/);
  assert.doesNotMatch(literalResult.stdout, /docs\/g\.md/);
});

test('configured output is root-relative, deterministic, and uses watched-file summaries', t => {
  const config = {
    groups: { related: { include: ['source/**'] } },
    watch: [{ include: ['docs/*.md'], groups: ['related'] }]
  };
  const repository = createRepository(t, {
    'nested/catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'nested/docs/a.md': '# A\n',
    'nested/docs/z.md': '# Z\n',
    'nested/source/service.txt': 'before\n'
  });
  writeFile(repository, 'nested/source/service.txt', 'after\n');

  const first = runCli(['nested'], repository);
  const second = runCli(['nested'], repository);
  assertStatus(first, 1);
  assert.equal(second.status, first.status);
  assert.equal(second.stdout, first.stdout);
  assert.equal(second.stderr, first.stderr);
  assert.ok(first.stdout.indexOf('docs/a.md') < first.stdout.indexOf('docs/z.md'));
  assert.doesNotMatch(first.stdout, /nested\/docs\//);
  assert.match(first.stdout, /2 watched files checked/i);
  assert.doesNotMatch(first.stdout, /Markdown files checked/i);
});

test('configured watched files are reported missing after every tracked-current-content removal state', t => {
  const cases = [
    {
      name: 'unstaged deletion',
      remove(repository) {
        fs.rmSync(path.join(repository, 'docs/guide.md'));
      }
    },
    {
      name: 'staged deletion',
      remove(repository) {
        fs.rmSync(path.join(repository, 'docs/guide.md'));
        runGit(repository, ['add', '-u']);
      }
    },
    {
      name: 'cached-only removal with a physical copy left behind',
      remove(repository) {
        runGit(repository, ['rm', '--cached', '--quiet', 'docs/guide.md']);
        assert.equal(fs.existsSync(path.join(repository, 'docs/guide.md')), true);
      }
    },
    {
      name: 'staged rename',
      remove(repository) {
        runGit(repository, ['mv', 'docs/guide.md', 'docs/renamed.md']);
      }
    }
  ];

  for (const fixture of cases) {
    const repository = configuredWatchFixture(t);
    fixture.remove(repository);
    const result = runCli([], repository);

    assertStatus(result, 1);
    assert.match(result.stdout, /missing: docs\/guide\.md \(threshold 20\.00%\)/);
    assert.match(result.stdout, /1 watched file checked; 1 watched file is missing/i, fixture.name);
  }
});

test('required configuration fields and semantic rule constraints are all exercised through the CLI', t => {
  const repository = createRepository(t, {
    'catchmydrift.config.json': '{}\n',
    '.catchmydrift-state.json': '{"version":1,"reviews":{}}\n',
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'service\n'
  });
  const validGroups = { related: { include: ['source/**'] } };
  const validWatch = [{ include: ['docs/guide.md'], groups: ['related'] }];
  const cases = [
    { name: 'empty object', config: {} },
    { name: 'missing groups', config: { watch: validWatch } },
    { name: 'missing watch', config: { groups: validGroups } },
    { name: 'empty groups', config: { groups: {}, watch: validWatch } },
    { name: 'empty watch', config: { groups: validGroups, watch: [] } },
    { name: 'numeric schema URI', config: { $schema: 2020, groups: validGroups, watch: validWatch } },
    {
      name: 'duplicate group reference',
      config: { groups: validGroups, watch: [{ include: ['docs/guide.md'], groups: ['related', 'related'] }] }
    },
    {
      name: 'state-only literal group',
      config: { groups: { state: { include: ['.catchmydrift-state.json'] } }, watch: [{ include: ['docs/guide.md'], groups: ['state'] }] }
    },
    {
      name: 'state-only wildcard group',
      config: { groups: { state: { include: ['**/.catchmydrift-state.json'] } }, watch: [{ include: ['docs/guide.md'], groups: ['state'] }] }
    },
    {
      name: 'fully excluded wildcard watch',
      config: { groups: validGroups, watch: [{ include: ['docs/*.md'], exclude: ['docs/*.md'], groups: ['related'] }] }
    },
    {
      name: 'fully excluded literal watch',
      config: { groups: validGroups, watch: [{ include: ['docs/guide.md'], exclude: ['docs/guide.md'], groups: ['related'] }] }
    }
  ];

  for (const fixture of cases) {
    writeConfig(repository, fixture.config);
    const result = runCli([], repository);
    assertStatus(result, 2);
  }
});

test('configured non-Markdown watched files retain no-text warnings and watched-file wording', t => {
  const config = {
    groups: { binary: { include: ['source/image.bin'] } },
    watch: [{ include: ['docs/coverage.txt'], groups: ['binary'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'docs/coverage.txt': 'Coverage is maintained here.\n',
    'source/image.bin': Buffer.from([0, 1, 2, 3])
  });

  const result = runCli([], repository);

  assertStatus(result, 0);
  assert.match(result.stdout, /warning: docs\/coverage\.txt: No measurable current text lines/i);
  assert.match(result.stdout, /1 watched file checked/i);
  assert.doesNotMatch(result.stdout, /Markdown/i);
});

test('the Draft 2020 schema and runtime both reject invalid configuration shapes and path forms', t => {
  const repository = createRepository(t, {
    'catchmydrift.config.json': '{}\n',
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'service\n'
  });
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(configurationSchema);
  const valid = {
    $schema: 'https://example.test/catchmydrift.schema.json',
    threshold: 25,
    groups: {
      related: { include: ['source/**'], exclude: ['source/generated/**'] }
    },
    watch: [{ include: ['docs/guide.md'], groups: ['related'], threshold: 50 }]
  };
  const invalid = [
    {},
    { groups: { related: { include: ['source/**'] } } },
    { watch: [{ include: ['docs/guide.md'], groups: ['related'] }] },
    { groups: {}, watch: [] },
    { groups: { related: { include: [] } }, watch: [] },
    { $schema: 2020, groups: { related: { include: ['source/**'] } }, watch: [{ include: ['docs/guide.md'], groups: ['related'] }] },
    { groups: { related: { include: ['source/**'] } }, watch: [{ include: ['docs/guide.md'], groups: ['related', 'related'] }] },
    baseConfig({ groups: { related: { include: ['../source/**'] } } }),
    baseConfig({ groups: { related: { include: ['/source/**'] } } }),
    baseConfig({ groups: { related: { include: ['C:\\source\\**'] } } }),
    baseConfig({ groups: { related: { include: ['//server/share/**'] } } }),
    baseConfig({ watch: [{ include: ['docs/../guide.md'], groups: ['related'] }] })
  ];

  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assertStatus(runCli([], repository), 2);

  for (const config of invalid) {
    assert.equal(validate(config), false, JSON.stringify(config));
    writeConfig(repository, config);
    assertStatus(runCli([], repository), 2);
  }
});

test('a declared but unused __proto__ group is still validated for a no-match error', t => {
  const groups = Object.fromEntries([
    ['related', { include: ['source/**'] }],
    ['__proto__', { include: ['does-not-exist/**'] }]
  ]);
  const config = {
    groups,
    watch: [{ include: ['docs/guide.md'], groups: ['related'] }]
  };
  const repository = createRepository(t, {
    'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
    'docs/guide.md': '# Guide\n',
    'source/service.txt': 'service\n'
  });

  const result = runCli([], repository);

  assertStatus(result, 2);
  assert.match(result.stderr, /__proto__/);
});

test('reserved group names, including __proto__, remain referenceable in configured CLI checks', t => {
  for (const groupName of ['__proto__', 'constructor', 'prototype']) {
    const config = {
      groups: Object.fromEntries([[groupName, { include: ['source/service.txt'] }]]),
      watch: [{ include: ['docs/guide.md'], groups: [groupName] }]
    };
    const repository = createRepository(t, {
      'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
      'docs/guide.md': '# Guide\n',
      'source/service.txt': 'before\n'
    });
    writeFile(repository, 'source/service.txt', 'after\n');

    const result = runCli([], repository);
    assertStatus(result, 1);
    assert.match(result.stdout, /docs\/guide\.md/, groupName);
    assert.doesNotMatch(result.stderr, /unknown group/i, groupName);
  }
});

test('Draft 2020 validation and normalization agree on NUL rejection and LF or CR-safe values', t => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(configurationSchema);
  const nulGroupGlob = baseConfig({ groups: { related: { include: ['source/\0service.txt'] } } });
  const nulWatchGlob = baseConfig({ watch: [{ include: ['docs/\0guide.md'], groups: ['related'] }] });

  for (const config of [nulGroupGlob, nulWatchGlob]) {
    assert.equal(validate(config), false, JSON.stringify(config));
    assert.throws(() => normalizeConfig(config), /must not be absolute or escape|root-relative POSIX glob/);
  }

  for (const control of ['\n', '\r']) {
    const globConfig = baseConfig({
      groups: { related: { include: [`source/${control}service.txt`] } },
      watch: [{ include: [`docs/${control}guide.md`], groups: ['related'] }]
    });
    assert.equal(validate(globConfig), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => normalizeConfig(globConfig));

    const groupName = `line${control}group`;
    const namedGroupConfig = {
      groups: Object.fromEntries([[groupName, { include: ['source/service.txt'] }]]),
      watch: [{ include: ['docs/guide.md'], groups: [groupName] }]
    };
    assert.equal(validate(namedGroupConfig), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => normalizeConfig(namedGroupConfig));
  }
});

test('LF and CR group names are schema-valid, normalizable, and referenceable through the CLI', t => {
  for (const control of ['\n', '\r']) {
    const groupName = `line${control}group`;
    const config = {
      groups: Object.fromEntries([[groupName, { include: ['source/service.txt'] }]]),
      watch: [{ include: ['docs/guide.md'], groups: [groupName] }]
    };
    const repository = createRepository(t, {
      'catchmydrift.config.json': `${JSON.stringify(config)}\n`,
      'docs/guide.md': '# Guide\n',
      'source/service.txt': 'before\n'
    });
    writeFile(repository, 'source/service.txt', 'after\n');

    const result = runCli([], repository);
    assertStatus(result, 1);
    assert.match(result.stdout, /docs\/guide\.md/);
  }
});
