# Changesets

For a user-facing change, run `npm run changeset`, select `catchmydrift`, choose
the appropriate version bump, and write a release note. Commit the generated
Markdown file with the change. Runtime dependency updates also need a changeset;
development tooling and documentation-only changes usually do not.

On pushes to `main`, `.github/workflows/release.yml` runs the test suite (including
the installed packed-package consumer test). Pending changesets produce a release
PR with the version bump, changelog, and refreshed npm lockfile. Merging that PR
publishes the new version to npm and creates its GitHub release. The workflow can
also be dispatched manually on `main` to retry a failed run. No automatic merge
is enabled.

`npm run release:version` intentionally updates `package-lock.json` after changing
the package version. Installation and publication jobs use `npm ci` to validate
the committed lockfile. `npm run release` publishes; do not use it as a local
validation command.

## One-time account setup

- Enable the [Renovate GitHub App](https://github.com/apps/renovate) for
  `pmcelhaney/catchmydrift`. The root `renovate.json` configures npm and GitHub
  Actions updates, pinned versions, a dependency dashboard, and lockfile
  maintenance. Dependency PRs require manual review and merge.
- In GitHub **Settings → Actions → General**, enable **Allow GitHub Actions to
  create and approve pull requests**. The workflow uses the built-in GitHub token.
  PRs created with that token do not trigger ordinary PR workflows automatically;
  the release workflow tests the merged commit again before publishing.
- In the npm `catchmydrift` package's **Settings → Trusted publishing**, add a
  GitHub Actions publisher with user **pmcelhaney**, repository **catchmydrift**,
  workflow filename **release.yml**, and no environment. Allow direct
  **npm publish**. This workflow uses short-lived OIDC credentials, so no
  `NPM_TOKEN` repository secret is needed. The first publisher must be configured
  on npmjs.com; committing this workflow does not create that trust relationship.

See the [Changesets action documentation](https://github.com/changesets/action)
and [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
