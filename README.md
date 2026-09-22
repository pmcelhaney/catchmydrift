# catchmydrift

`catchmydrift` is a Git-backed command-line check for keeping related files in
sync. Out of the box, it finds drift in Markdown documentation. With a small
JSON configuration, it can watch **any Git-tracked file**—for example,
`AGENTS.md`, runbooks, skill instructions, configuration, or source-adjacent
notes—and relate it to the groups of files that should keep it current.

The command reads Git history plus staged and unstaged tracked changes. It
never changes the files it checks.

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

## Zero-configuration checks

With no `catchmydrift.config.json` in the selected root, catchmydrift:

- watches every Git-tracked file whose name ends in lowercase `.md`;
- relates each watched Markdown file to every Git-tracked file in the same
  directory and its descendants; and
- ignores directories that contain no tracked lowercase Markdown file.

For example, `docs/README.md` is related to all tracked files under `docs/`,
while a root-level `README.md` is related to all tracked files in the
repository. Files ending in `.MD` are not selected by this default mode.

```sh
# Check the current directory (the default)
catchmydrift

# `check` is optional and equivalent
catchmydrift check

# Limit a check to a tracked repository subdirectory
catchmydrift check docs

# Allow up to five percent drift before the check fails
catchmydrift --threshold=5
```

The positional root must be inside a Git repository. Output paths are relative
to that selected root.

## Configuration

Creating `catchmydrift.config.json` in the selected root switches from the
zero-configuration Markdown rules to the configured rules. The configuration
has named groups of related files and one or more watch rules. All globs are
root-relative POSIX globs; dotfiles are matched. `include` is required for a
group and a watch rule; `exclude` is optional.

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
      "include": ["README.md", "docs/**/*.md"],
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

In this example, documentation and `AGENTS.md` are watched explicitly. A
watch rule can select arbitrary Git-tracked file types, not only Markdown.
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
catchmydrift --config config/catchmydrift.json

# Here `docs` is the selected root and patterns in its config are relative to docs/
catchmydrift check docs --config docs/catchmydrift.config.json
```

The package includes [catchmydrift.schema.json](catchmydrift.schema.json) for
editor JSON-schema support and validation tooling. The example points to the
schema in a local development-dependency installation; adjust `$schema` if you
copy the schema elsewhere.

## What counts as drift

catchmydrift compares each related text file with the selected baseline and
calculates:

```text
(inserted text lines + deleted text lines) / current related text lines
```

The current denominator includes tracked content in the working tree and
index, so staged and unstaged changes are visible. A result equal to the
threshold is healthy; only a higher percentage fails.

Binary files do not contribute to the line-based calculation in v1. A group
containing only binary content therefore reports no text to measure rather
than treating byte changes as line drift. Review snapshots (described below)
still preserve binary and final-symlink content so that a reviewed snapshot
cannot silently become stale.

`.catchmydrift-state.json` is always excluded from watched and related
content, even if a configuration glob would otherwise select it.

## Review a file without editing it

Use `review` after you have assessed a watched file and its current related
content. It marks that exact snapshot as current without changing the watched
file:

```sh
catchmydrift review docs/README.md

# Review an arbitrary configured watched file
catchmydrift review AGENTS.md --config catchmydrift.config.json

# Review paths under a subdirectory root
catchmydrift review README.md --root docs
```

`review` accepts one or more exact, currently watched file paths. Its options
may appear before or after the paths:

```text
catchmydrift review <file...> [--root <root>] [--config <path>]
```

Use `--` before a filename that begins with `-`. `--threshold` belongs only to
`check`, not `review`.

Review validates all supplied paths before it writes anything. It rejects
paths outside the selected root, missing or unsafe working-tree paths, and
paths that are not currently watched. A batch review is atomic: an invalid
target does not leave a partial review state behind.

On success, the only file it may create or update is
`.catchmydrift-state.json` in the selected root. It does not modify, touch,
stage, or commit the watched file or any other content. The state records a
normalized relationship definition and the exact tracked working-tree snapshot
that was reviewed. catchmydrift prints a reminder; stage and commit the state
file together with the reviewed changes yourself if the approval should travel
with the repository:

```sh
catchmydrift review docs/README.md
git add docs/README.md docs/service.js .catchmydrift-state.json
git commit -m "Review docs for service changes"
```

Before that commit, the local review is still useful: the check is healthy only
while the exact reviewed snapshot remains in place. A related edit makes it a
stale approval and fails the check regardless of the configured threshold;
running `review` again records a new snapshot. Once committed, the review is
portable to a fresh clone. If the relationship configuration changes,
catchmydrift warns and ignores the old approval. A later commit that changes a
watched file also supersedes its older review baseline.

Treat `.catchmydrift-state.json` as review evidence. Malformed, unsupported,
or internally inconsistent review state is unhealthy rather than silently
ignored.

## Commands and exit status

```text
catchmydrift [check] [root] [--threshold <0-100>] [--config <path>]
catchmydrift review <file...> [--root <root>] [--config <path>]
catchmydrift --help
catchmydrift --version
```

`check` is the default command. `review` uses `--root` because it has one or
more file arguments; `check` uses its optional positional root.

| Exit status | Meaning |
| --- | --- |
| `0` | The check is healthy, or a review was recorded successfully. |
| `1` | A watched file exceeded its threshold, is missing, or has a stale or invalid review approval/state. |
| `2` | Command usage, root, configuration, or review-target validation failed. |
