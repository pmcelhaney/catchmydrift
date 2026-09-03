# catchmydrift repository instructions

## Current purpose and product invariants

This repository is being renamed from `docdr`/`docdelta` to **catchmydrift**. It is a CommonJS, Node.js >= 22 command-line tool backed by Git. These are intended product requirements; do not describe them as already implemented unless the relevant code and tests prove that they are.

- With zero configuration, inspect every Git-tracked, lowercase `.md` file and relate it to all Git-tracked files in that file's directory subtree.
- With configuration, support named include/exclude glob groups and arbitrary watched Git-tracked files.
- Calculate drift as `(inserted text lines + deleted text lines) / current related text lines`.
- Ignore binary files in v1.
- A review must bind to the normalized relationship definition and the exact tracked working-tree content that was reviewed. It may atomically update only `.catchmydrift-state.json`; it must not modify, touch, stage, or commit watched files or any other path.
- Keep Git interaction safe: use discrete argument arrays (never shell-built Git commands), constrain user-supplied paths to the selected scan root (which must be inside a Git repository), and make command output and state deterministic.
- Exclude `.catchmydrift-state.json` itself from watched/related content.
- Tests use `node:test` and temporary, real Git repositories.

## Implementation workflow

- Work in small, reviewable slices. Complete at least one focused commit per authorized slice, but only the primary integration agent may stage, commit, or otherwise integrate changes.
- Preserve all unrelated user work. Do not clean up, reformat, move, stage, or edit files beyond the authorized slice.
- Do not push branches, publish packages, or make external changes unless expressly authorized.
- Prefer simple, portable CommonJS code compatible with Node.js >= 22; add tests that demonstrate observable behavior rather than relying only on source inspection.
- Before integrating or committing an implementation slice, run the most relevant targeted tests, the complete `npm test` suite, and `git diff --check` for the changed paths. If a required check cannot run, stop and report the blocker instead of advancing to the next slice.
- Before release-oriented handoff, verify an installed packed-package consumer scenario in addition to source-tree tests; a tarball existing by itself is not acceptance evidence.
- Report the exact files changed, checks run, results, and any untested or uncertain behavior. Do not overstate completion.
- Stop and ask for direction if the authorized scope, product semantics, safety boundary, or expected behavior is materially ambiguous.
