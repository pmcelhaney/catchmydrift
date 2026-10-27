'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let core;
const { check, parseThreshold } = require('../index');
const { normalizeScanRoot, runGit, isWithin } = require('../lib/git');

function bool(name, fallback = false) {
  const value = core.getInput(name);
  if (!value) return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`Input ${name} must be true or false.`);
  return value === 'true';
}
async function run() {
  core = await import('@actions/core');
  const root = path.resolve(process.env.GITHUB_WORKSPACE || '.', core.getInput('root') || '.');
  const workspace = fs.realpathSync(process.env.GITHUB_WORKSPACE || '.');
  if (!isWithin(workspace, fs.realpathSync(root))) throw new Error('root must stay within GITHUB_WORKSPACE.');
  const { repositoryRoot } = normalizeScanRoot(root);
  if (runGit(['rev-parse', '--is-shallow-repository'], repositoryRoot).stdout.toString('utf8').trim() === 'true') {
    core.setFailed('Catch My Drift requires full Git history. Set fetch-depth: 0 on actions/checkout and rerun the job.');
    return;
  }
  const threshold = core.getInput('threshold');
  const scan = check(root, { config: core.getInput('config') || undefined, cwd: workspace,
    ...(threshold ? { threshold: parseThreshold(threshold), thresholdProvided: true } : {}) });
  const report = { driftDetected: scan.failed, results: scan.results.map(({ watchedPath, baseline, percent, threshold, missing }) =>
      ({ watchedPath, baseline, percent: Number.isFinite(percent) ? percent : null, threshold, missing: !!missing })) };
  const output = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'catchmydrift-'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  core.setOutput('report-directory', output);
  core.setOutput('drift-detected', String(scan.failed));
  core.summary.addHeading('Catch My Drift').addRaw(`Drift detected: ${scan.failed}.\n\nSee report.json in the report artifact for results.`);
  await core.summary.write();
  if (bool('fail-on-drift') && scan.failed) core.setFailed('Documentation drift exceeds the configured threshold.');
}
if (require.main === module) run().catch(() => core.setFailed('Catch My Drift could not analyze this checkout. Check inputs, full Git history, and configuration; see the README for setup instructions.'));
module.exports = { run };
