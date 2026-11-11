# @metaharness/jujutsu 0.2.2: agenticow peer pinned to 0.3.1

Package: `@metaharness/jujutsu@0.2.2` only.

## Changed

- The optional `agenticow` peer is now pinned exactly to `0.3.1` (was the open range `^0.2.0`, which excluded the current agenticow 0.3.x). The API the bridge uses — `open()`, `fork(label, path, { nativeAnn: true })`, `ingest`, `query`, `checkpoint`, `rollback`, `diff`, `promote` — behaves identically on 0.2.4 and 0.3.1.
- **Upgrade note:** a project that has agenticow 0.2.x installed alongside this package will now see a peer conflict. Install `agenticow@0.3.1`.

## Tests

- New `__tests__/agenticow-live.test.ts` imports the real `agenticow@0.3.1` (exact devDependency) and drives `AgenticowMemoryProvider` + `AgenticowQueryProvider` through branch, ingest, native cross-branch query, checkpoint/rollback and promote, and checks `probe()` reports `memory` and `annAcrossBranch`.

The README quickstart was run against the packed tarball in a clean directory outside the home directory. Without peers it prints `memory: false`, `learn: {"opCount":3,"ingested":3}`, `merge: {"ingested":3,"deleted":0}`.

The README now carries an animated flow diagram (ADR-356).
