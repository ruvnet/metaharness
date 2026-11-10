# @metaharness/kernel 0.1.8: ships its wasm backend

Package: `@metaharness/kernel@0.1.8` only.

## Fix

- Every published version up to 0.1.7 shipped without `pkg/` (`ruflo_kernel_wasm.js`,
  `ruflo_kernel_wasm_bg.wasm`), even though the package describes itself as WASM-first.
  `loadKernel()` silently fell back to the pure-JS backend, and
  `loadKernel({ backend: 'wasm' })` threw
  `kernel backend "wasm" was requested but is unavailable: wasm artifact (pkg/ruflo_kernel_wasm.js) not present`.
  0.1.8 includes `pkg/`, so a plain install now answers from the wasm backend.
- Same root cause as `@metaharness/horizon` 0.2.1: the wasm is gitignored and the Release
  workflow never built it. Since #486 the workflow runs `build:wasm` for every package that
  declares `metaharness.wasmArtifacts` and fails the release if a declared file is missing
  from the tarball; the installed-artifact smoke asserts `loadKernel().backend === 'wasm'`.
- README quickstart output updated to what a clean install of the packed 0.1.8 tarball prints
  (`kernel 0.1.0 (wasm backend)`; `kernelInfo().version` is the Rust kernel's version).
- `@metaharness/arc-agi-3` and `@metaharness/arc-agi-3-chatgpt` pin `@metaharness/kernel` 0.1.8 in source.

No API changes.
