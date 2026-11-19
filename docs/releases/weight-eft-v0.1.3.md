# @metaharness/weight-eft 0.1.3: package metadata, README and fixes

Package: `@metaharness/weight-eft@0.1.3` only.

## Fixes

- The `weight-eft` bin did nothing when run through npm's `node_modules/.bin` symlink. The main-module guard now compares real paths. Covered by `__tests__/bin-symlink.test.ts`.

## Metadata (ADR-356)

- `homepage` is `https://ruv.io`; `repository` points at `https://github.com/ruvnet/metaharness.git` with `directory: packages/weight-eft`; `bugs` points at the metaharness issue tracker.
- Description rewritten to state the package's one job in 197 characters; 15 keywords, each tied to a real feature.
- README opens with the one job, supported environments, a quickstart whose expected output was captured from a clean install of the packed tarball, and one link to the next package. All earlier README content is kept under "Reference".

No API changes.
