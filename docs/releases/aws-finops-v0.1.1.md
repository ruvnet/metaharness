# @metaharness/aws-finops 0.1.1: package metadata, README and fixes

Package: `@metaharness/aws-finops@0.1.1` only.

## Fixes

- `npm run build` never compiled this package (it was missing from `scripts/build-ordered.mjs`), so 0.1.0 reached npm without `dist/` and `import '@metaharness/aws-finops'` failed. It is now built, and `__tests__/build-ordered-coverage.test.ts` fails if any package with a build script is left out of the build phases.

## Metadata (ADR-356)

- `homepage` is `https://ruv.io`; `repository` points at `https://github.com/ruvnet/metaharness.git` with `directory: packages/aws-finops`; `bugs` points at the metaharness issue tracker.
- Description rewritten to state the package's one job in 186 characters; 10 keywords, each tied to a real feature.
- README opens with the one job, supported environments, a quickstart whose expected output was captured from a clean install of the packed tarball, and one link to the next package. All earlier README content is kept under "Reference".

No API changes.
