# @metaharness/horizon 0.2.2: ships its wasm again

Package: `@metaharness/horizon@0.2.2` only.

## Fix

- 0.2.1 was published without `wasm/horizon_core.wasm`. The import succeeded, but
  `HorizonCore.load()` (and with it `CommandGuard`, `HaltController`, `CompactionPolicy`
  and `LongHorizonDriver`) failed with
  `ENOENT: no such file or directory, open '.../node_modules/@metaharness/horizon/wasm/horizon_core.wasm'`.
  0.2.2 includes the wasm. The Release workflow now runs `build:wasm` for every package that
  declares `metaharness.wasmArtifacts` and fails the release if a declared file is missing
  from the tarball.

## Metadata (ADR-356)

- `homepage` is `https://ruv.io`; `repository` points at `https://github.com/ruvnet/metaharness.git`
  with `directory: packages/horizon`; `bugs` points at the metaharness issue tracker.
- README opens with the one job, supported environments, a quickstart and a link to the next package.
  All earlier README content is kept under "Reference".

No API changes.
