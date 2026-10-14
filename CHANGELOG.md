# catchmydrift

## 0.1.0

### Minor Changes

- 18f2ee3: Simplify review state to an unversioned map of watched file paths to last-reviewed commit SHAs. Reviews now apply only to committed content and reject staged or unstaged changes in selected watched and related files. Checks use the newer of the saved review commit and the last watched-file update, with subsequent changes measured as ordinary percentage drift. Ship a JSON schema for the new state format; the previous versioned snapshot format is no longer supported.

## 0.0.2

### Patch Changes

- 0623fad: Default drift checks to a 20% threshold when no command-line or configuration threshold is set.
