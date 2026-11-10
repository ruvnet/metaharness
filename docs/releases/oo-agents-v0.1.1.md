# @metaharness/oo-agents 0.1.1: package metadata, README, wasm release check

Package: `@metaharness/oo-agents@0.1.1` only.

## Release

- The wasm sandbox (`wasm/ooa_cell_vm.wasm`) is now built by the Release workflow and the
  release fails if it is missing from the tarball. Before this, republishing would have
  shipped without the wasm, so `CellVm.load()` and `Runtime.create()` would have failed.

## Metadata (ADR-356)

- `homepage` is `https://ruv.io`; `repository` points at `https://github.com/ruvnet/metaharness.git`
  with `directory: packages/oo-agents`; `bugs` points at the metaharness issue tracker.
- README opens with the one job, supported environments, a quickstart and a link to the next package.
  All earlier README content is kept under "Reference".

No API changes.
