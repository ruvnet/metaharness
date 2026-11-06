# @metaharness/kernel 0.1.4 — current @ruvector/rvf range and provenance

Package: `@metaharness/kernel@0.1.4` only.

- Optional peer `@ruvector/rvf`: `^0.2.0` → `^0.2.0 || ^0.3.0 || ^0.4.0`. Under `^0.2.0`, installing the kernel next to the current `@ruvector/rvf@0.4.6` failed with `ERESOLVE` (npm 10). With the new range the two install together and `npm ls` dedupes rvf. The `RvfDatabase` / `NodeBackend` / `WasmBackend` surface is the same in 0.2.0 and 0.4.6.
- `repository.url` and `homepage` now point at `ruvnet/metaharness`, so the package passes the Release workflow's provenance check.
- Ships the `SessionLog.append()` / `fork()` TOCTOU fix (#385), which merged after 0.1.3 was published.
- The private `arc-agi-3` and `arc-agi-3-chatgpt` packages pin `0.1.4` to match the workspace.

Known limitation, unchanged by this release: `createRvfBackend()` looks for a `createIndex` export, and no published `@ruvector/rvf` version (0.2.x through 0.4.6) has one. So it returns `null`, and memory stays on the in-process HNSW whichever rvf is installed. `isRvfAvailable()` returns `true` when rvf is installed. This release fixes installation only. It does not add a working RVF memory backend.

| Range | Before | After |
| --- | --- | --- |
| `@metaharness/kernel` → `@ruvector/rvf` (peer, optional) | `^0.2.0` | `^0.2.0 \|\| ^0.3.0 \|\| ^0.4.0` |
| `@metaharness/kernel` → `@ruvector/emergent-time` | `^0.1.0` | unchanged |

The published file list matches 0.1.3 (`dist/**`, `README.md`, `LICENSE`, `package.json`).

Reproduce: `npm ci --ignore-scripts`, `npm run build`, `RELEASE_PACKAGES=kernel-js node scripts/dream-release.mjs pack`, `RELEASE_PACKAGES=kernel-js node scripts/dream-release.mjs smoke`. Then, in an empty directory, run `npm install <kernel tarball> @ruvector/rvf@0.4.6`. It succeeds with 0.1.4 and fails with `ERESOLVE` with 0.1.3.
