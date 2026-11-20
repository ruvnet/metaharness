# @metaharness/darwin 0.16.0: SIM data-loss fix, checkpoints, signed handoff

Package: `@metaharness/darwin@0.16.0` only.

## Upgrade notice for 0.15.0 SIM users

0.15.0 could make an opt-in SIM journal or snapshot unreadable. Passing a stored `SimAttempt` (which carries `hash`/`previousHash`) back to `append()` wrote a record whose hash no longer verified, and the next load refused the whole file (#529).

- If you use `sim`, `SimMemory` or `SimJournal`, upgrade to 0.16.0, and pause new production SIM writes on 0.15.0 until you have.
- Keep existing journals and snapshots. Don't delete or rewrite them. Records written correctly by 0.15.0 still load in 0.16.0, and loading is unchanged.
- Default Darwin use (no `sim` config, or `mode: off`) never touched SIM storage and is not affected.

## Changes

- **#529 append-input validation.** `validateSimAttemptInput()` (exported) accepts exactly the `SimAttemptInput` fields and the six `scope` fields, and names any extra field in its error. Every append path (`SimJournal`, the `SimMemory` snapshot and the `SimMemory` journal) checks the input and its JSON clone before taking the lease or writing. Extra fields now throw instead of being stored.
- **#522 / #528 checkpoints and migration.**
  - Opt-in journal checkpoint manifests with bounded, verified replay and fallback to a full replay. Tested at 100k records with a SIGKILLed writer.
  - `migrateSimSnapshotToJournal`, `rollbackSimJournalToSnapshot` and `writeSimJournal`, which are verbatim, idempotent and lease-held.
  - `bench/sim-endurance.mjs`.
- **#526 guards.** `@ruvector/rvf` must be >= 0.2.0 for `openRvfSimIndex`. On Linux, `SimJournal` refuses network filesystems unless `allowNetworkFilesystem: true`.
- **#524 / #527 signed handoff v2.** `signSimHandoff`, `verifySimHandoff` and `signedRufloHandoff` provide an Ed25519, tenant-scoped envelope for Ruflo ingestion. Signing is not wired into `evolve()`.

## Evidence and limits

- SIM remains experimental. Benchmarks are synthetic, and held-out model gains are not measured.
- The journal is verified on local filesystems only. Power-loss durability is not verified.

## Compatibility

- No change when `sim` is not set or `mode` is `off`. No new required dependency.
- `metaharness` (create-agent-harness) still pins `@metaharness/darwin@0.13.1`.
