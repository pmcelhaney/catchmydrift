---
"catchmydrift": minor
---

Simplify review state to an unversioned map of watched file paths to last-reviewed commit SHAs. Reviews now apply only to committed content and reject staged or unstaged changes in selected watched and related files. Checks use the newer of the saved review commit and the last watched-file update, with subsequent changes measured as ordinary percentage drift. Ship a JSON schema for the new state format; the previous versioned snapshot format is no longer supported.
