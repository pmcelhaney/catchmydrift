'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { check, parseThreshold } = require('../index');
const { normalizeScanRoot, runGit, isWithin } = require('../lib/git');

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
if (require.main === module) {
  try { run(); } catch {
    setFailed('Catch My Drift could not analyze this checkout. Check inputs, full Git history, and configuration; see the README for setup instructions.');
  }
}
module.exports = { run };
