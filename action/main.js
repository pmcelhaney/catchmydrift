'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let core;
const { check, parseThreshold } = require('../index');
const { buildContext, requestReview, validatePatterns } = require('./review');

function bool(name, fallback = false) {
  const value = core.getInput(name);
  if (!value) return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`Input ${name} must be true or false.`);
  return value === 'true';
}
function integer(name, fallback, min, max) {
  const raw = core.getInput(name);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Input ${name} must be ${min}–${max}.`);
  return value;
}
function eventPolicy(env = process.env) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') throw new Error('pull_request_target is unsupported.');
  if (!['pull_request', 'push', 'workflow_dispatch', 'schedule'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Unsupported event.');
  return { fork: env.GITHUB_EVENT_NAME === 'pull_request' &&
    (!event.pull_request?.head?.repo?.full_name || event.pull_request.head.repo.full_name !== env.GITHUB_REPOSITORY) };
}
async function run() {
  core = await import('@actions/core');
  const key = core.getInput('openai-api-key');
  if (key) core.setSecret(key);
  const policy = eventPolicy();
  const ai = bool('ai-review');
  const root = path.resolve(process.env.GITHUB_WORKSPACE || '.', core.getInput('root') || '.');
  const workspace = fs.realpathSync(process.env.GITHUB_WORKSPACE || '.');
  const relative = path.relative(workspace, fs.realpathSync(root));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('root must stay within GITHUB_WORKSPACE.');
  const threshold = core.getInput('threshold');
  const scan = check(root, { config: core.getInput('config') || undefined, cwd: workspace,
    ...(threshold ? { threshold: parseThreshold(threshold), thresholdProvided: true } : {}) });
  const report = { driftDetected: scan.failed, results: scan.results.map(({ watchedPath, baseline, percent, threshold, missing }) =>
      ({ watchedPath, baseline, percent: Number.isFinite(percent) ? percent : null, threshold, missing: !!missing })),
    ai: { status: 'disabled' } };
  if (ai) {
    if (policy.fork) report.ai = { status: 'skipped_fork' };
    else {
      if (!key || !core.getInput('model')) throw new Error('AI review requires openai-api-key and an explicit model.');
      const maxTokens = integer('max-output-tokens', 2000, 256, 4000);
      const timeoutMs = integer('timeout-seconds', 30, 1, 60) * 1000;
      const patterns = core.getInput('ai-files').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      validatePatterns(patterns);
      try {
        const context = buildContext(scan, patterns);
        const review = await requestReview(context, { key, model: core.getInput('model'), maxTokens, timeoutMs });
        report.ai = { ...review, head: context.head, coverage: context.coverage };
      } catch {
        // Do not log provider bodies/errors or repository contents: these may contain secrets.
        report.ai = { status: 'unavailable', explanation: 'AI review failed, exceeded limits, or returned invalid evidence. Drift detection is unchanged.' };
        core.warning(report.ai.explanation);
      }
    }
  }
  const output = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'catchmydrift-'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'proposed.patch'), report.ai.patch || '');
  core.setOutput('report-directory', output);
  core.setOutput('drift-detected', String(scan.failed));
  core.setOutput('ai-status', report.ai.status);
  core.summary.addHeading('Catch My Drift').addRaw(`Drift detected: ${scan.failed}. AI review: ${report.ai.status}.\n\nSee the report artifact for findings and a proposed patch. Repository and model text is not rendered here.`);
  await core.summary.write();
  if (bool('fail-on-drift') && scan.failed) core.setFailed('Documentation drift exceeds the configured threshold.');
  if (bool('fail-on-ai-error') && report.ai.status === 'unavailable') core.setFailed('AI review unavailable; see report artifact.');
}
if (require.main === module) run().catch(() => core.setFailed('Catch My Drift could not analyze this checkout. Check inputs, full Git history, and configuration; no provider response or repository content was logged.'));
module.exports = { run, eventPolicy };
