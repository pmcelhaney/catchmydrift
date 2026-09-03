# catchmydrift

Checks documentation for drift against Git-tracked changes.

## Usage

This is the current interim command: it checks each directory below the supplied root for a `README.md`. If code has changed significantly since a directory's README was last updated, that README is probably overdue for a checkup.

```sh
$ npx catchmydrift [root]

Checking README.md files for drift...

 86.63% ./account/activity
      ! ./app
      ! ./home/iframes
 59.79% ./home/widgets
      ! ./utilities/report

found 3 missing and 2 outdated READMEs
```

A percentage next to a directory means the directory has changed that much (according to Git)
since its README.md file was last updated. You might want to give that README some attention!

A "!" next to a directory means the README.md file is missing altogether.

If any problems are found, catchmydrift exits with code 1. Otherwise it exits with code 0, so you can add it to your build system.

### Options

The `--threshold=n` option sets the percent change you want to allow before a README is considered
outdated (for example, `--threshold=5` allows up to 5% change). Standard `--help` and `--version` options are also available.

## Installation

Run directly without installing using npx:

```sh
npx catchmydrift
```

Or install globally:

```sh
npm install -g catchmydrift
```

Or install as a dev dependency and add catchmydrift to the "scripts" section of your package.json:

```sh
npm install --save-dev catchmydrift
```

```json
{
  "scripts": {
    "check-docs": "catchmydrift --threshold=5"
  }
}
```
