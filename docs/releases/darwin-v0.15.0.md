# @metaharness/darwin 0.15.0: opt-in SIM optimizer memory

Package: `@metaharness/darwin@0.15.0` only.

## SIM optimizer memory (experimental, ADR-325)

- `SimMemory` records each independently scored optimizer attempt, including failures and regressions, in a hash-linked local store scoped by owner, repo and interface.
- `evolve()` accepts an opt-in `sim` config. Only the proposer sees prior history, as bounded, untrusted context. Scoring, promotion, the risk gate and the safety validator do not read SIM.
- Retrieval works with a supplied embedder and vector index, including `openRvfSimIndex()` over the optional `@ruvector/rvf`, or with deterministic lexical matching.

## Durable journal with a single-writer lease (#521)

- `SimJournal` (`persistence: journal`) appends one fsynced JSONL record per attempt.
- A cross-process lease (`<journal>.lock`, created with O_EXCL) admits one writer per journal; others get `SimJournalLockedError`. Every append re-checks the lease token and the committed file size before writing.
- A lease left by a dead process on the same host is recovered automatically; a lease from another host never is.
- The next writer copies an unterminated final record aside and truncates it; a complete corrupt record is fatal. `load()` is read-only.
- Tests run two real writer processes, four racing processes, a writer SIGKILLed partway through a record, and an injected fault at each write boundary. Every acknowledged record survived exactly once.

## Evidence and limits

- `bench/sim-continuation.mjs` and `bench/sim-journal.mjs` are synthetic. They do not measure LLM gains (`heldoutModelScores: NOT_MEASURED`).
- The journal is verified on local filesystems only. NFS/SMB and power-loss durability are not verified.

## Compatibility

- No change when `sim` is not set or `mode` is `off`.
- No new required dependency. `@ruvector/rvf` is loaded only if installed.
- `metaharness` (create-agent-harness) still pins `@metaharness/darwin@0.13.1`; this release does not change that pin.
