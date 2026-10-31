# catchmydrift

<img src="https://raw.githubusercontent.com/pmcelhaney/catchmydrift/main/docs/images/catch-my-drift-logo-b3-readme.png" alt="Catch My Drift — an angle-bracket kite with a curved tail" width="600">

`catchmydrift` is a Git-backed command-line check that reminds busy engineers and their agents to keep documentation up to date.
It works by making sure each context / documentation file is updated when the code files it supports have drifted.

For example, running it in a repository with documentation, agent guidance, and
a skill file might show:

```console
$ npx catchmydrift
27.43% (threshold 20.00%) AGENTS.md
36.18% (threshold 20.00%) README.md
52.67% (threshold 20.00%) skills/code-review/SKILL.md
3 watched files checked; 3 watched files exceed the 20.00% threshold.
```

Here, the files related to each watched file have drifted beyond the default 20%
threshold, so the command exits with status `1`. Review the documentation and
update it as needed, or [record a review without editing it](#review-a-file-without-editing-it).

The threshold, as well as the relationship between files-that-drift and files-that-should-be-updated, can be customized with a small configuration file.

- Drift results and exit codes are **deterministic**.
- Checks do not modify files. Recording a review updates only `.catchmydrift-state.json`.
- It does not try to understand what changed; it simply alerts that change has occurred.
- It prints a brief report and returns a pass / fail exit code.
- It can be used by people, agents, or CI.

## Table of contents

- [Install and run](#install-and-run)
- [Resolve a drift warning](#resolve-a-drift-warning)
- [Zero-configuration checks](#zero-configuration-checks)
- [Configuration](#configuration)
- [What counts as drift](#what-counts-as-drift)
- [Review a file without editing it](#review-a-file-without-editing-it)
- [Commands and exit status](#commands-and-exit-status)
- [GitHub Action](#github-action)
- [Update notifications](#update-notifications)

## Install and run

catchmydrift requires Node.js 22 or later and a Git repository.

When the package is available from your configured npm registry, install it as
a development dependency:

```sh
npm install --save-dev catchmydrift
```

Then run it from the repository root:

```sh
npx catchmydrift
```

The CLI may also report an available update; see [Update notifications](#update-notifications).

For continuous integration, add a script such as:

```json
{
  "scripts": {
    "check-drift": "catchmydrift --threshold=5"
  }
}
```

```sh
npm run check-drift
```

## Resolve a drift warning

A drift warning asks you to assess whether a watched file still matches its
related content. It does not establish that the documentation is inaccurate.
Start by reading the flagged file and the related changes since its
[baseline](#what-counts-as-drift).

For example, from the repository root, with zero configuration and no saved
review for `docs/README.md`, find its last-change commit and inspect the related
changes:

```sh
baseline=$(git log -1 --format=%H -- docs/README.md)
git diff --no-ext-diff --no-textconv "$baseline" -- docs/
```

This comparison includes committed changes since that baseline, plus staged and
unstaged tracked changes. It still shows committed changes when plain `git diff`
is empty. In zero-configuration mode, `docs/` is the related subtree for
`docs/README.md`. With configuration, inspect the paths selected by that watched
file's [related groups](#configuration) instead.

If `.catchmydrift-state.json` contains a saved review for the watched file, compare
that SHA with its last-change commit before choosing `baseline`. Run
`git rev-list --topo-order HEAD`: whichever of those two SHAs appears first is
the effective baseline. Set `baseline` to that full SHA before running the diff.
State keys are repository-relative, including when checking a subdirectory.

Use the diff to assess the documentation's claims. A changed service option or
return value may require updating its documented usage; an internal refactor
that preserves the documented behavior may leave the file accurate. Read enough
of the related code to make that decision before recording a review.

If the documentation needs updating, edit it and commit the update along with
any related changes you assessed. For example, after updating `docs/README.md`
to describe changes in `docs/service.js`:

```sh
git add docs/README.md docs/service.js
git commit -m "Document service changes"
npx catchmydrift
```

The commit that updates the watched file becomes its new baseline. An
uncommitted documentation edit does not reset the baseline.

If the documentation is already accurate, commit the related changes and
[record a review without editing the file](#review-a-file-without-editing-it).
Then run the check again.

For a repository with only `docs/README.md` watched and no subsequent related
changes, either path ends with:

```console
$ npx catchmydrift
Healthy: 1 watched file checked; no watched files exceed the 20.00% threshold.
```

A healthy check exits with status `0`. Other watched files may still need
attention; repeat the assessment for any remaining warnings. The check measures
change since the baseline; you assess whether the documentation is accurate.

## Zero-configuration checks

With no `catchmydrift.config.json` in the selected root, catchmydrift:

- watches every Git-tracked file whose name ends in lowercase `.md`; and
- relates each watched Markdown file to every Git-tracked file in the same
  directory and its descendants.

For example, `docs/README.md` is related to all tracked files under `docs/`,
while a root-level `README.md` is related to all tracked files in the
repository. Files ending in `.MD` are not selected by this default mode.
Directories without Markdown add no watched files of their own; their tracked
content can still contribute drift to an ancestor's watched Markdown file.

```sh
# Check the current directory (the default)
npx catchmydrift

# `check` is optional and equivalent
npx catchmydrift check

# Limit a check to a tracked repository subdirectory
npx catchmydrift check docs

# Allow up to five percent drift before the check fails
npx catchmydrift --threshold=5
```

The positional root must be inside a Git repository. Output paths are relative
to that selected root.

## Configuration

Creating `catchmydrift.config.json` in the selected root switches from the
zero-configuration Markdown rules to the configured rules. The configuration
has named groups of related files and one or more watch rules. A watch rule
chooses the file to review; its groups choose the files whose changes count
toward that review. All globs are root-relative POSIX globs; dotfiles are
matched. `include` is required for a group and a watch rule; `exclude` is optional.

To watch `README.md` for changes under `src/`, start with:

```json
{
  "groups": {
    "application": { "include": ["src/**"] }
  },
  "watch": [
    { "include": ["README.md"], "groups": ["application"] }
  ]
}
```

The examples assume the selected paths are Git-tracked. Adapt the paths to your
repository, removing wildcard includes for directories you do not have; unmatched
wildcard includes are configuration errors. Only paths selected by `watch` are
watched when configuration is present; other Markdown files are no longer discovered automatically.

After saving the minimal configuration, run `npx catchmydrift`. Confirm that
`README.md` appears with `threshold 20.00%` and that the summary reports one
watched file. A clean initial comparison can report `0.00%` drift. Changing a
tracked text file under `src/` should change the reported percentage; the check fails
only when that percentage exceeds the threshold. This lets you verify the
relationship before adding more rules.

For documentation, agent guidance, and a skill that should be reviewed when
application code changes, a fuller configuration adds exclusions and threshold
overrides:

```json
{
  "$schema": "./node_modules/catchmydrift/catchmydrift.schema.json",
  "threshold": 5,
  "groups": {
    "application": {
      "include": ["src/**", "package.json"],
      "exclude": ["src/generated/**"]
    },
    "agent-guidance": {
      "include": ["AGENTS.md", ".agents/**", "skills/**"]
    }
  },
  "watch": [
    {
      "include": ["README.md", "docs/**/*.md", "skills/code-review/SKILL.md"],
      "groups": ["application"],
      "threshold": 10
    },
    {
      "include": ["AGENTS.md"],
      "groups": ["application", "agent-guidance"]
    }
  ]
}
```

This example watches `README.md`, matching documentation, the named skill, and
`AGENTS.md` explicitly. The `skills/**` pattern in the `agent-guidance` group
also makes skill changes contribute drift to `AGENTS.md`; a group alone does
not make its files watched. A watch rule can select arbitrary Git-tracked file
types, not only Markdown.
Groups are unioned when a rule names more than one group, so a related path is
measured once even if several groups match it.

The effective threshold is chosen in this order:

1. `--threshold` on the `check` command
2. The watch rule's `threshold`
3. The configuration's top-level `threshold`
4. `20`

Each watched path may be selected by only one watch rule. A literal watched
path that is no longer tracked is reported as missing; a wildcard or group
that matches no historical tracked path is a configuration error. The
configuration file may itself be a watched or related file when its rule and
group select it.

Use a configuration other than the default with `--config`. Its resolved path
must remain inside the selected root:

```sh
# Current directory is the selected root
npx catchmydrift --config config/catchmydrift.json

# Here `docs` is the selected root and patterns in its config are relative to docs/
npx catchmydrift check docs --config docs/catchmydrift.config.json
```

The package includes [catchmydrift.schema.json](catchmydrift.schema.json) for
editor JSON-schema support and validation tooling. The example points to the
schema in a local development-dependency installation; adjust `$schema` if you
copy the schema elsewhere.

## What counts as drift

By default, the baseline is the last commit that changed the watched file.
A newer [recorded review](#review-a-file-without-editing-it) moves the baseline
forward; a later watched-file commit supersedes an older review.

catchmydrift compares each related text file with that baseline and calculates:

```text
(inserted text lines + deleted text lines) / current related text lines
```

For example, replacing 12 lines among 100 current related text lines contributes
12 deletions plus 12 insertions: `24 / 100 = 24%` drift.

The current denominator includes tracked content in the working tree and
index, so staged and unstaged changes are visible. A result equal to the
threshold is healthy; only a higher percentage fails.

Binary files do not contribute to the line-based calculation in v1. A group
containing only binary content therefore reports no text to measure rather
than treating byte changes as line drift. Reviews require binary and symlink
changes to be committed too, even though binary content does not contribute to
percentage drift.

`.catchmydrift-state.json` is always excluded from watched and related
content, even if a configuration glob would otherwise select it.

## Review a file without editing it

Use `review` after you have assessed a watched file against committed related
content. It records the current `HEAD` commit SHA as that file's review baseline
without editing the watched file.

Before reviewing, commit all staged and unstaged changes in the selected watched
file and its related tracked files. The example below assumes `docs/service.js`
is the only changed related file and `docs/README.md` is already accurate.

```sh
# Commit the changes you assessed first
git add docs/service.js
git commit -m "Update service"
npx catchmydrift review docs/README.md
```

A successful review prints:

```text
Approved: docs/README.md
Commit .catchmydrift-state.json to share these review baselines with the repository.
```

Share the baseline and check again:

```sh
git add .catchmydrift-state.json
git commit -m "Record documentation review"
npx catchmydrift
```

The reviewed file now uses the recorded baseline. With no subsequent related
changes it passes; other watched files can still fail. See the
[healthy-check example](#resolve-a-drift-warning).

If watched or related tracked content is still dirty, review exits with status
`2` and prints this error followed by command usage:

```text
catchmydrift: Review requires committed watched and related content. Commit staged and unstaged changes first.
```

Use `git status` and `git diff` (including `git diff --cached` for staged changes)
to inspect the relevant changes, commit them after assessment, and retry review.

Other review examples:

```sh
# Review an arbitrary configured watched file
npx catchmydrift review AGENTS.md --config catchmydrift.config.json

# Review paths under a subdirectory root
npx catchmydrift review README.md --root docs
```

`review` accepts one or more exact, currently watched file paths. Its options
may appear before or after the paths:

```text
catchmydrift review <file...> [--root <root>] [--config <path>]
```

Use `--` before a filename that begins with `-`. `--threshold` belongs only to
`check`, not `review`.

Review requires an existing commit and rejects staged or unstaged changes in
any selected watched file or its related tracked files, including additions,
deletions, binary files, and symlinks. Unrelated dirty files and untracked files
do not block a review. Review validates all targets before writing: an invalid
or dirty target leaves the entire batch unchanged. Paths outside the selected
root, missing or unsafe paths, and files that are not currently watched are
rejected.

### Review state

On success, the only file it may create or update is
`.catchmydrift-state.json` in the selected root. It does not modify, touch,
stage, or commit watched files or other content. The state is an unversioned
JSON object mapping repository-relative watched paths to full commit SHAs:

```json
{
  "docs/README.md": "89b5d14c84a4a05e7d3e204cb16b587ef647dc19"
}
```

The format is defined by `catchmydrift-state.schema.json`, shipped with the
package. Keys remain relative to the repository even when scanning a
subdirectory. Each SHA must identify a commit reachable from the current
`HEAD`. There is no version field, relationship signature, or file snapshot.
The previous versioned snapshot format is unsupported; remove the old state
file and run `review` again against committed content.

Saved reviews work locally immediately and travel to fresh clones when the
state file is committed. Repeating a review at the same `HEAD` produces
identical state. See [What counts as drift](#what-counts-as-drift) for baseline
selection.

Subsequent committed, staged, and unstaged related changes contribute ordinary
percentage drift, subject to the threshold. Relationships always come from the
current configuration; changing a relationship keeps the saved SHA as the
baseline and applies the new relationship to it. Review state itself is
excluded from drift. Malformed state, invalid paths, and SHAs that are missing,
are not commits, or are not reachable from `HEAD` make the check unhealthy.

## Commands and exit status

```text
catchmydrift [check] [root] [--threshold <0-100>] [--config <path>]
catchmydrift review <file...> [--root <root>] [--config <path>]
catchmydrift --help
catchmydrift --version
```

`check` is the default command. `review` uses `--root` because it has one or
more file arguments; `check` uses its optional positional root.

| Exit status | Meaning                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `0`         | The check is healthy, or a review was recorded successfully.                                        |
| `1`         | A watched file exceeded its threshold, is missing, or has invalid review state. |
| `2`         | Command usage, root, configuration, or review-target validation failed.                             |

## GitHub Action

Run drift checks in GitHub Actions without installing npm dependencies in your
project. Choose an installation method below, then inspect the report artifact
to assess any warnings. Checks are advisory by default; set `fail-on-drift: 'true'`
to make drift fail the job.

A full Git history is required to find each watched file's last-change commit
and resolve saved review SHAs. Set `fetch-depth: 0` on `actions/checkout`: zero
means all history, whereas the default depth of one fetches only a single commit.
The Action rejects shallow checkouts with setup instructions.

### Install with your AI

Give this prompt to an AI coding assistant with access to your repository:

```text
Install the catchmydrift GitHub Action in this repository. Follow the setup instructions at https://github.com/pmcelhaney/catchmydrift/blob/main/README.md#github-action. Adapt the example to our existing workflows and configuration, and validate the resulting workflow.
```

### Install manually

Copy [the example workflow](https://github.com/pmcelhaney/catchmydrift/blob/main/examples/drift-workflow.yml)
to `.github/workflows/drift.yml`, replacing `ACTION_COMMIT_SHA` with the full
reviewed commit SHA containing this Action.

```yaml
name: Documentation drift
on: [pull_request, workflow_dispatch]
permissions:
  contents: read
jobs:
  drift:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: pmcelhaney/catchmydrift@ACTION_COMMIT_SHA
        id: drift
      - uses: actions/upload-artifact@v4
        if: always() && steps.drift.outputs.report-directory != ''
        with:
          name: catchmydrift-review
          path: ${{ steps.drift.outputs.report-directory }}
          retention-days: 7
```

By default this runs offline, does not fail for drift, and needs only `contents: read`. Set `fail-on-drift: 'true'` to gate a job on the existing deterministic threshold. The Action never commits, stages, updates review state, changes source files, opens a PR, merges, or runs repository scripts. It does not post PR comments and requires no write token. For private repositories, keep the report artifact accessible only to intended reviewers.

### Inputs, outputs, and failures

| Input | Default | Purpose |
| --- | --- | --- |
| `root` | `.` | Scan directory within `GITHUB_WORKSPACE` |
| `config` | auto-discover | Existing JSON configuration path, relative to workspace |
| `threshold` | configuration or 20 | Override drift threshold percentage |
| `fail-on-drift` | `false` | Fail when deterministic drift exceeds threshold |

Outputs: `drift-detected` (`true`/`false`) and `report-directory`. The directory contains `report.json` with `driftDetected` and per-file results: watched path, baseline SHA, drift percentage, threshold, and missing-file status. An infinite drift percentage is represented as `null` in JSON. The job summary shows whether drift was detected.

When the report identifies drift, [resolve the warning](#resolve-a-drift-warning)
by assessing the related changes, then updating the documentation or
[recording a review](#review-a-file-without-editing-it) if it is already accurate.

Invalid inputs, shallow history, unhealthy state/configuration, or failed analysis fail the step. Drift itself fails the step only with `fail-on-drift: 'true'`. The Action does not fetch history automatically; configure checkout before running it.

### Maintaining the Action

This section is for contributors changing or distributing the Action. It runs
on Node 24 supplied by the Actions runner. The committed `dist/` bundle contains
catchmydrift and its runtime dependencies. The wrapper uses GitHub environment
files directly for outputs and the job summary, without the Actions toolkit.

Repositories can consume `pmcelhaney/catchmydrift@<full-commit-SHA>` directly;
a Marketplace listing is optional. Use a full reviewed SHA for reproducibility.
Maintainers can publish releases and major-version tags such as `v1`; movable
tags can change behavior between runs. Publishing releases, moving tags, and
accepting Marketplace agreements are separate maintainer tasks. See
[GitHub's JavaScript Action guide](https://docs.github.com/actions/tutorials/creating-a-javascript-action)
and [publishing guide](https://docs.github.com/en/actions/sharing-automations/creating-actions/publishing-actions-in-github-marketplace).

For Action changes, run `npm ci`, `npm run build:action`, `npm test`, and `git diff --check`. Commit the regenerated `dist/` files alongside source. CI rebuilds the bundle and checks for differences, then exercises it from a separate consumer directory without `node_modules`. Tests use real temporary Git histories, including shallow and full-history consumer checkouts.

## Update notifications

On `check` and `review`, the CLI checks the public npm registry for the latest
release. If it is newer than the running version, a warning on stderr shows both
versions and these upgrade options:

```sh
npm install --save-dev catchmydrift@latest  # Project dependency
npm install --global catchmydrift@latest   # Global installation
npx catchmydrift@latest                   # One-off run
```

The lookup has a 1.5-second deadline. Network errors, invalid responses, and
timeouts are silently ignored; the warning never changes drift results or exit
codes. It writes no cache or other files and never upgrades automatically.
Help, version output, and programmatic `main`, `check`, and `review` calls stay
offline. CI environments (`CI` set to a nonempty value other than `false` or `0`)
skip the lookup. Set `CATCHMYDRIFT_NO_UPDATE_CHECK=1` to disable it elsewhere,
including when using a private registry or working offline.
