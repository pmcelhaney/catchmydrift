# catchmydrift accessibility

## Scope

This statement covers catchmydrift's command-line interface and the documentation in this repository.
catchmydrift is a Git-backed Node.js command-line tool, with no graphical user interface of its own.
It does not assess the accessibility of the files it watches or the editors, terminals, Git tools, and CI services used with it.

## Current support

- Commands and options are available as text through `catchmydrift --help` and in the [README](README.md).
- Checks produce line-oriented text, including file paths, drift percentages, thresholds, and messages for missing files or invalid review state.
  Status is communicated in words and numbers rather than requiring color interpretation.
- The [documented exit statuses](README.md#commands-and-exit-status) let scripts and CI distinguish healthy checks, drift or review-state failures, and usage or configuration failures.
- The tool accepts command-line arguments without an interactive menu or pointer input.

These are interface characteristics supported by the code and documentation, not a guarantee of assistive-technology compatibility.

## Limitations and verification gaps

This statement does not establish WCAG conformance or certify any terminal or screen-reader combination.
Screen-reader reading order, pronunciation of file paths, and usability of long reports have not been evaluated as part of preparing this statement.
Output contains technical paths, percentages, and Git-related terminology that may require familiarity with the [README](README.md).
The repository's tests check command behavior and text output; passing them does not establish accessibility for people using assistive technology.

## Report a barrier

Please [open an issue in the catchmydrift issue tracker](https://github.com/pmcelhaney/catchmydrift/issues/new) to report a barrier in the CLI or documentation.
If possible, include the command or documentation section, expected and actual behavior, steps to reproduce, and the catchmydrift version.
Your operating system, terminal, and assistive technology can help explain the problem, but share only what you are comfortable making public.
Remove private repository content and sensitive file paths from examples and output.
You do not need to identify a WCAG criterion or propose a fix.
This statement sets no response-time or remediation deadline.
