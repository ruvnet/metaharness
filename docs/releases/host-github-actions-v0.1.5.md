# @metaharness/host-github-actions 0.1.5: package metadata, README and fixes

Package: `@metaharness/host-github-actions@0.1.5` only.

## Fixes

- README: a GitHub Actions workflow that evaluates a harness on every push (`npm test`, `harness doctor`, `harness score`, score artifact), run end to end on a GitHub-hosted runner before release.

## Metadata (ADR-356)

- `homepage` is `https://ruv.io`; `repository` points at `https://github.com/ruvnet/metaharness.git` with `directory: packages/host-github-actions`; `bugs` points at the metaharness issue tracker.
- Description rewritten to state the package's one job in 159 characters; 12 keywords, each tied to a real feature.
- README opens with the one job, supported environments, a quickstart whose expected output was captured from a clean install of the packed tarball, and one link to the next package. All earlier README content is kept under "Reference".

No API changes.
