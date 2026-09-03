#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

function exec(command, args) {
  return childProcess.execFileSync(command, args, {encoding: 'utf8'}).trim()
}

function flatten(lists) {
  return lists.reduce(function(a, b) {
    return a.concat(b);
  }, []);
}

function getDirectories(srcpath) {
  return fs.readdirSync(srcpath)
    .map(file => path.join(srcpath, file))
    .filter(path => fs.statSync(path).isDirectory());
}

function getDirectoriesRecursive(srcpath) {
  return [srcpath, ...flatten(getDirectories(srcpath).map(getDirectoriesRecursive))];
}

function countInsertionsAndDeletionsSinceHash(hash, directoryPath) {
  const stat = exec('git', ['diff', hash, '--shortstat', directoryPath]);
  if (!stat) {
    return 0;
  }
  const statNumbers = stat.match(/\d+/g).map(s => parseInt(s, 10));
  const [filesChanged, insertions, deletions] = statNumbers;
  return (insertions || 0) + (deletions || 0);
}


function checkDirectory(directory) {
  if (!fs.existsSync(path.join(directory, 'README.md'))) {
    return {
      path: directory,
      missing: true,
      score: 0
    };
  }

  const INITIAL_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  const hash = exec('git', ['log', '-n1', '--pretty=%H', '--', path.join(directory, 'README.md')]);

  return {
    path: directory,
    missing: false,
    score: countInsertionsAndDeletionsSinceHash(hash, directory) / countInsertionsAndDeletionsSinceHash(INITIAL_HASH, directory)
  }
}

function percentFormat(n) {
  return `      ${Math.round(n * 10000) / 100}%`.slice(-7);
}

function main() {
  const argv = yargs(hideBin(process.argv))
    .scriptName('catchmydrift')
    .usage('$0 [root]')
    .option('threshold', {
      describe: 'Percent change allowed before a README is considered outdated',
      type: 'number',
      default: 0
    })
    .strictOptions()
    .help()
    .version()
    .parse();
  const rootPath = argv._[0] || process.cwd();
  const threshold = argv.threshold;
  const directories = getDirectoriesRecursive(rootPath);

  let missingCount = 0;
  let outdatedCount = 0;

  process.stdout.write('Checking README.md files for drift... ')

  directories.forEach(directory => {
    const result = checkDirectory(directory);

    const directoryName = `.${directory.slice(rootPath.length)}`;

    if (result.missing) {
      missingCount++;
      process.stdout.write(`\n      ! ${directoryName}`);
      return;
    }

    if (result.score > threshold / 100) {
      outdatedCount++;
      process.stdout.write(`\n${percentFormat(result.score)} ${directoryName}`);
    }

  });

  if (missingCount + outdatedCount > 0) {
    process.exitCode = 1;
    const messageParts = [];
    if (missingCount > 0) {
      messageParts.push(`${missingCount} missing`);
    }
    if (outdatedCount > 0) {
      messageParts.push(`${outdatedCount} outdated`);
    }
    process.stdout.write(`\nfound ${messageParts.join(' and ')} README${missingCount + outdatedCount === 1 ? '' : 's'}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  exec,
  flatten,
  getDirectories,
  getDirectoriesRecursive,
  countInsertionsAndDeletionsSinceHash,
  checkDirectory,
  percentFormat,
  main
};
