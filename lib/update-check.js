'use strict';

const https = require('node:https');
const semver = require('semver');

const LATEST_URL = 'https://registry.npmjs.org/catchmydrift/latest';

// Best effort only: no files, subprocesses, redirects, or persistent cache.
function lookupLatestVersion({ get = https.get, timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    let request;
    let response;
    let settled = false;
    const finish = version => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response?.destroy();
      request?.destroy();
      resolve(version);
    };
    // A wall-clock deadline also bounds DNS, TLS, and slow response bodies.
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      request = get(LATEST_URL, { headers: { Accept: 'application/json' } }, incoming => {
        response = incoming;
        incoming.on('error', () => finish(null));
        incoming.on('aborted', () => finish(null));
        if (incoming.statusCode !== 200) {
          finish(null);
          return;
        }
        let size = 0;
        const chunks = [];
        incoming.on('data', chunk => {
          size += chunk.length;
          if (size > 64 * 1024) {
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          try {
            const version = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.version;
            finish(typeof version === 'string' ? semver.valid(version) : null);
          } catch {
            finish(null);
          }
        });
      });
      request.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

async function warnIfOutdated({ installedVersion, stderr, env = process.env, lookup = lookupLatestVersion }) {
  if (env.CATCHMYDRIFT_NO_UPDATE_CHECK === '1' ||
      (env.CI && env.CI !== 'false' && env.CI !== '0')) return;
  try {
    const latest = await lookup();
    if (!semver.valid(installedVersion) || !semver.valid(latest) || !semver.gt(latest, installedVersion)) return;
    stderr.write(
      `catchmydrift: warning: installed version ${installedVersion}; latest version ${latest} is available.\n` +
      'Upgrade a project dependency: npm install --save-dev catchmydrift@latest\n' +
      'Upgrade a global install: npm install --global catchmydrift@latest\n' +
      'Run once without installing: npx catchmydrift@latest\n'
    );
  } catch {
    // Registry failures must never change a check or review result.
  }
}

module.exports = { lookupLatestVersion, warnIfOutdated };
