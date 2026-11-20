# Self Improvement Memory (SIM) for Darwin Mode

SIM is **opt in experience memory for the harness optimizer**. It is not ordinary agent task memory and is not a scoring or promotion authority. It complements Darwin's existing archive and implements the cross run memory design in ADR-074. See [ADR-325](../../docs/adrs/ADR-325-continual-self-improvement-memory.md) and [implementation issue #518](https://github.com/ruvnet/metaharness/issues/518).

## Example

```ts
import { join } from 'node:path';
import { evolve, SimMemory } from '@metaharness/darwin';

const workRoot = '/safe-owner-data/run-1';
const memory = new SimMemory('/safe-owner-data/optimizer-experiences.json');
const scope = {
  ownerId: 'authenticated-tenant-id',
  repoId: 'ruvnet/metaharness',
  interfaceId: 'darwin-v1',
  modelId: 'coding-model-version',
  benchmarkId: 'public-training-suite-v1',
  harnessVersion: '0.14.0',
};

await evolve({
  repoRoot: '/checked-out-repository',
  workRoot, generations: 3, childrenPerGeneration: 2,
  promotionDelta: 0.02, tasks: ['check-1'],
  sim: { store: memory, mode: 'retrieval', scope, maxTokens: 512 },
});
```

The example assumes the repo and tasks are set up for normal Darwin execution. Without an embedder and vector index, `retrieval` uses **deterministic lexical** ranking. For a full history ablation, use `mode: 'full'`. To roll back to the original Darwin behavior, omit `sim` or set `mode: 'off'`.

When an LLM-backed generator supports it, it receives a bounded `simContext` containing untrusted optimizer evidence. The existing `DeterministicMutator` intentionally ignores it, making it suitable for a disabled/unchanged baseline.

## Optional native RuVector retrieval

Install `@ruvector/rvf` >= 0.2.0 (0.4.7+ recommended, with a working native runtime) separately. The package is not required by Darwin. Versions before 0.2.0 return every string id as `"0"`, so `openRvfSimIndex` refuses them, and also refuses when it cannot read the installed version.

```ts
import { openRvfSimIndex, indexSimAttempt } from '@metaharness/darwin';

const vectorIndex = await openRvfSimIndex('/tenant-1/index.rvf', 384);
if (!vectorIndex) {
  // The optional package is not installed. Use lexical retrieval instead.
} else {
  // Embeddings MUST come from a compatible, separately configured model.
  const embedder = {
    embed: async (text: string): Promise<number[]> => yourEmbeddingFunction(text),
  };
  // Historical records must first be indexed, e.g.:
  for (const record of memory.all()) {
    await indexSimAttempt(record, embedder, vectorIndex);
  }
  // Pass both embedder and vectorIndex into the SimRunConfig.
  await vectorIndex.close?.();
}
```

The `yourEmbeddingFunction` identifier is a placeholder. This package **does not bundle or remotely invoke any embedding model**. Supply a local embedder if confidentiality matters, or explicitly approve an external service. Use a separate index path for every owner and enforce tenant identity in the calling service. The native RVF index is a search accelerator, not the authoritative record store.

## Ruflo coordination seam

```ts
const handoff = await memory.rufloHandoff({
  scope, query: 'failed retry handling', mode: 'retrieval',
  maxTokens: 512,
});
console.log(JSON.stringify(handoff));
```

The returned data is a portable, explicit `metaharness.sim.handoff.v1` document with provenance and untrusted evidence labeling. This is **not** a claim that it has already been consumed by a Ruflo swarm, nor an instruction to trust its contents.

### Signed handoff (v2) for authenticated ingestion

A v1 document is unauthenticated: its hash chain detects corruption, not a forger. To hand evidence to Ruflo, sign it:

```ts
import { createPrivateKey } from 'node:crypto';
import { signedRufloHandoff, simKeyId, verifySimHandoff } from '@metaharness/darwin';

const privateKey = createPrivateKey(pemFromYourKeyStore); // Ed25519
const envelope = await signedRufloHandoff(memory, {
  scope, query: 'failed retry handling', mode: 'retrieval', maxTokens: 512,
}, { privateKey, retentionDays: 30 });
// envelope = { payload: { schema: 'metaharness.sim.handoff.v2', eventId, keyId, tenant,
//              createdAt, expiresAt, consent, retention, handoff }, signature: { alg: 'ed25519', value } }
```

- **Signature:** Ed25519 over `"metaharness.sim.handoff.v2\n" + canonicalJson(payload)` (sorted keys, no whitespace, finite numbers only).
- **Ids:** `keyId` is `ed25519:` plus a hash of the public key. `eventId` is a hash of `{ tenant, handoff }`, so redelivery or re-signing the same evidence keeps the same id and consumers can deduplicate.
- **Tenant:** `{ owner, repo }`, taken from the handoff scope by default. The producer refuses to sign records from another owner/repo, and records carrying fields outside the SimAttempt allowlist (for example hidden test output). The tenant name allows `[A-Za-z0-9._-]`, and the repo may contain one `/`.
- **Consent and retention:** consent is fixed to optimizer-only use with no sharing and manual-review-only promotion. `retentionDays` (1 to 3650, default 30) tells the consumer how long to keep it. `expiresAt` is at most 30 days after `createdAt` (default 7).

Verification (`verifySimHandoff(envelope, { trustedKeys, now })`) returns a typed reason on failure: `unsigned`, `malformed`, `unknown_key`, `key_id_mismatch`, `revoked_key`, `key_expired`, `bad_signature`, `expired`, `not_yet_valid`, `tenant_not_authorized`, `scope_mismatch`, `event_id_mismatch` or `too_large`. A trusted key entry is `{ keyId, publicKey (SPKI PEM), tenants: ['owner/repo'], revoked?, notAfter? }`. The binding of a key to its tenants lives only in the consumer's configuration: a valid signature from a key bound to tenant A never authorizes a payload naming tenant B.

The Ruflo consumer is `ruflo metaharness sim-ingest` (opt-in, disabled until `.claude-flow/sim/trusted-keys.json` sets `"enabled": true`). It verifies independently, writes to namespace `sim:<owner>/<repo>` in its own database (separate from task-agent memory), deduplicates by event id, supports revoking an event or a key, and keeps an audit log. `bench/sim-handoff-fixture.mjs` regenerates the signed cross-repo fixture (public keys only), which is committed to both repositories. Signing is not called by `evolve()`, so Darwin scoring is unchanged whether or not you use it. Core Memory promotion stays a manual issue/PR workflow; nothing is shared automatically.

## Experimental append-only journal

`SimJournal` is now exported as a separate **opt-in persistence primitive**, with one fsynced JSONL event per append, hash chain verification, strict shared SIM schema validation, incomplete-tail recovery, and a cross-process single-writer lease. The existing `SimMemory` snapshot remains the default for `evolve()`. A journal backend is now available through the same optimizer memory interface, with an explicit opt-in. Migration between the two is explicit (see below); nothing migrates automatically.

```ts
import { SimJournal } from '@metaharness/darwin';
const journal = new SimJournal('/safe-owner-data/optimizer-events.jsonl');
const recovery = await journal.load();
console.log(recovery); // { records, recoveredTailBytes }
await journal.append(validatedSimAttempt); // takes the writer lease on first append
await journal.close();                       // releases it
```

To use the fsynced journal in Darwin without changing the scorer:

```ts
import { SimMemory, evolve } from '@metaharness/darwin';
const store = new SimMemory('/safe-owner-data/optimizer-events.jsonl', {
  persistence: 'journal',
});
// Pass `sim: { store, mode: 'retrieval', scope }` into the existing evolve config.
// Use a new .jsonl path; do not point the journal at an existing snapshot.
// Call `await store.close()` when done to release the writer lease.
```

The adapter is covered by a Darwin E2E parity test.

### Single-writer lease

- **Readers** may call `load()` from any process. It is read-only and never changes the file; an unterminated final record is reported in `recoveredTailBytes` and ignored.
- **The writer** takes `<journal>.lock` on its first `append()` (or `acquire()`), created atomically with `O_EXCL` and holding `{ pid, host, token }`. Any other writer, in this process or another, gets `SimJournalLockedError` (`code: SIM_JOURNAL_LOCKED`) until `close()`. A process that exits normally releases the lease automatically.
- **Stale leases**: a lease from a dead pid on the same host is removed under a separate `.lock.break` mutex, and only if it is byte-identical to the lease judged stale. A half-written lease counts as stale after `staleLeaseMs` (default 10 s). A lease from another host is never broken automatically; remove it by hand once that writer is confirmed gone.
- **Fencing**: before every write, the writer re-reads the lease token and checks that the file still ends where it last committed. If either changed, it commits nothing and poisons itself.
- **Recovery**: an append is acknowledged only after the whole line is written and fsynced. The next lease holder copies any unterminated tail to `<journal>.torn-<time>-<id>` and truncates it. A complete corrupt record is fatal and is never truncated. After a fault, a record whose full line reached the file but was never acknowledged may be present once; retrying it with the same id is rejected as a duplicate.
- **After an I/O failure** the instance is poisoned: `close()` it, then open a new instance, which recovers under the lease.

Tests cover two real writer processes, four racing processes (every acknowledged record exactly once), a writer SIGKILLed partway through a record, and an injected fault at each write boundary.

**Limits:** local filesystems only. On Linux, a journal directory on NFS, SMB/CIFS, AFS, Ceph or 9p (including WSL `/mnt/*` drives) is refused with `SIM_JOURNAL_UNSUPPORTED_FS`, because `O_EXCL` lock files and fsync are not reliable there; `allowNetworkFilesystem: true` overrides this at your own risk. On macOS and Windows the filesystem type is not checked, so keep the journal on a local disk. Power-loss durability has not been tested on real hardware. A reused pid makes a stale lease look live, which fails closed. Only a final unterminated record is recoverable; complete corrupt records fail closed. Do not treat a hash chain as an authenticated signature or durable multi-node transaction. Append fsync guarantees rely on the underlying filesystem's fsync implementation and hardware.

### Checkpoints (#522)

Replaying a journal re-verifies every record (schema, sha256, chain), which is O(history). A checkpoint manifest bounds that work:

```ts
const journal = new SimJournal(path, { checkpointEvery: 1000 }); // automatic, every 1,000 appends
await journal.checkpoint();                                       // or explicitly
const reader = new SimJournal(path);
await reader.load();
reader.checkpointStatus(); // { status: 'used', checkpointRecords, replayedRecords }
```

- `<journal>.checkpoint` (`metaharness.sim.checkpoint.v1`) records the committed byte offset, record count, chain-head hash and sha256 of the covered prefix. Only the lease holder writes it, fenced like an append, by temp file + fsync + rename + directory fsync. The writer keeps a running hash of committed bytes, so a checkpoint costs one small file write and never rereads the journal.
- A reader uses a manifest only if the offset lands on a record boundary inside the committed file, the prefix sha256 matches, and the prefix holds exactly the manifest's record count and chain head. Records after the offset are then fully verified. Anything else (corrupt JSON, tampered hash, offset out of range or mid-record, wrong count or head, a manifest copied from another journal) is reported as `status: 'rejected'` with a `reason`, and the reader does a full verified replay. It never truncates anything because of a manifest. An older manifest is still valid and just replays more.
- A failed automatic checkpoint never fails the append it follows; the record is already durable, the previous manifest stays in place, and `lastCheckpointError()` reports it.
- `all()`/`count()` stay complete: the covered prefix is still hashed and parsed (without per-record re-hashing). What is bounded is the number of records fully re-verified, not the bytes read. Load time and RSS still grow with the file, as the measurements below show.
- Pass `{ checkpoints: false }` to ignore manifests and always verify everything. `SimMemory` forwards journal options: `new SimMemory(path, { persistence: 'journal', journal: { checkpointEvery: 1000 } })`.

### Migration and rollback (#522)

```ts
import { migrateSimSnapshotToJournal, rollbackSimJournalToSnapshot } from '@metaharness/darwin';
await migrateSimSnapshotToJournal('/data/sim.json', '/data/sim.jsonl');   // { status: 'migrated', records, chainHead }
await rollbackSimJournalToSnapshot('/data/sim.jsonl', '/data/sim-rollback.json');
```

Both copy records verbatim, so negative outcomes, evidence ids, scope and the hash chain are unchanged. They run under the journal's writer lease, verify the source chain, write the target atomically, then re-read it and compare count and chain head. The source is never modified. Re-running against an identical target returns `status: 'unchanged'` and writes nothing; a target holding different records, or the same path for both, is refused. Migration also installs a checkpoint over the migrated records. Rollback fails closed when the records would exceed the snapshot's 16 MiB limit (about 19,000 records of typical size). `writeSimJournal(records, path)` writes any verified chain to a new journal the same way.

Reproduce local synthetic persistence measurements:

```bash
npm run bench:sim-journal -w @metaharness/darwin
SIM_BENCH_RECORDS=2000 node packages/darwin-mode/bench/sim-journal.mjs
```

On one ruOS Software Factory run, the 2,000-record snapshot baseline sustained 82 writes/s and the fsynced journal sustained 1,831 writes/s (22.33 times faster). This is a **single-machine microbenchmark**, not a crash-power-loss test, and the journal is not used by the default Darwin integration.

### Endurance measurements (#522)

`npm run bench:sim-endurance -w @metaharness/darwin` (`bench/sim-endurance.mjs`) runs every arm in a fresh child process, one after another (they share one device, so parallel fsync streams would distort each other), and prints its methodology. Results: `bench/results/sim-endurance.json`. One run: Node v22.23.2, Linux 6.17, AMD Ryzen 9 9950X, ext4 on NVMe, fsync per acknowledged append, 95% CIs by fixed-seed bootstrap (200 resamples). The machine was shared with other work, so treat tails as indicative.

Appending N records to a new journal (per-record fsync):

| arm | records | rec/s (95% CI) | p50 / p95 / p99 ms | disk | write amp. app / block | max RSS |
|---|---|---|---|---|---|---|
| journal | 10,000 | 3,561 [3,534, 3,584] | 0.26 / 0.34 / 0.49 | 6.9 MB | 1.000 / 6.95 | 96 MB |
| journal + checkpoint/1000 | 10,000 | 3,539 [3,521, 3,559] | 0.27 / 0.35 / 0.50 | 6.9 MB | 1.0005 / 6.95 | 96 MB |
| journal | 100,000 | 1,469 [1,427, 1,504] | 0.31 / 3.68 / 4.11 | 69.2 MB | 1.000 / 6.92 | 284 MB |
| journal + checkpoint/1000 | 100,000 | 1,793 [1,767, 1,822] | 0.32 / 2.21 / 2.61 | 69.2 MB | 1.0005 / 6.93 | 289 MB |

The median append rises only slightly with history (0.26 → 0.31 ms); the p95/p99 tail grows much more at 100k (cause not isolated; the heap is ~190 MB larger). The checkpoint arm was faster at 100k in both full runs (1,506 vs 2,312 rec/s, then 1,469 vs 1,793), which checkpointing does not explain; it always ran second, so an order effect is not ruled out and the gap is unexplained. Block-level write amplification is ~7x because each fsync of a ~690-byte line writes at least one 4 KiB page plus filesystem metadata.

Loading (5 fresh processes each; the checkpoint arm has a fixed 100-record tail after its last checkpoint):

| records | load | records fully verified | p50 / max ms | max RSS |
|---|---|---|---|---|
| 10,000 | full verify | 10,000 | 59 / 64 | 93 MB |
| 10,000 | checkpoint | 100 | 26 / 27 | 82 MB |
| 100,000 | full verify | 100,000 | 542 / 552 | 307 MB |
| 100,000 | checkpoint | 100 | 273 / 277 | 301 MB |

A checkpoint halves load time and bounds per-record verification to the tail, but **load time still grows with history** (26 ms → 273 ms for 10x the records), because the prefix is still hashed and parsed so `all()` is complete.

Sustained append cost at a fixed history H, against the unmodified snapshot and a bench-local snapshot with equal durability (temp file fsync + rename + directory fsync per append):

| history H | journal rec/s | snapshot + fsync rec/s | snapshot (no fsync) rec/s | journal vs snapshot + fsync (95% CI) |
|---|---|---|---|---|
| 1,000 | 3,085 | 376 | 560 | 8.2x [7.1, 9.2] |
| 5,000 | 2,482 | 87 | 107 | 28.7x [24.5, 32.1] |
| 10,000 | 2,777 | 45 | 58 | 61.4x [57.9, 64.3] |
| 19,000 | 2,226 | 26 | 26 | 86.7x [64.9, 101.4] |
| 20,000 | 2,888 | over the 16 MiB snapshot cap | — | — |

Each snapshot append rewrites the whole file (16.5 MB per append at H = 19,000), so the gap widens with history. At H = 1,000 it is under 10x. There is no snapshot arm at 100k: the format cannot hold it.

**Not measured:** 1,000,000 records (a journal is capped at 100,000 records); power loss; network filesystems; other machines. Two full runs were made; the tables show the second.

## Verification and operational reality

```bash
npm run lint -w @metaharness/darwin
npx vitest run packages/darwin-mode/__tests__/sim-memory.test.ts packages/darwin-mode/__tests__/sim-evolve.test.ts
npm run bench:sim -w @metaharness/darwin
```

The benchmark is a fixed 40-record, four-query **synthetic retrieval experiment** comparing no history, full bounded history, and retrieved history. It measures context precision, recall in budget, latency and approximate tokens only, not AI model improvement. The same fixed fixtures and seeds are used for all three arms.

**Input:** `append()` (snapshot and journal) accepts exactly the `SimAttemptInput` fields, checked with `validateSimAttemptInput()` before anything is written. A stored `SimAttempt` passed back in (it carries `hash`/`previousHash`), or any unknown field (including in `scope`), is rejected. Up to 0.15.0 such input was written and then failed verification on the next load, making the file unreadable. Loading still accepts stored records as before.

**Failure modes:** Cross-model transfer is only a prior and must be independently tested. Stale or poisoned records may bias proposals. The local hash chain detects accidental corruption, not a malicious writer. Persistence is safe for a single writer; do not share a snapshot across processes without a real lock/transaction layer. Index ingestion errors fail explicitly rather than silently claiming vector retrieval. External evaluation data stays out of SIM, which stores only evidence references and final measured scores. No secrets or raw hidden tests should be stored in the record.

**Acceptance beyond this PR:** independent model evals with sealed heldout suites, matching candidate counts, budgets and model versions, reproducible negative-transfer ablations, signed receipts and at least 2 held out score points gained without security or cost regressions. No such improvement is claimed from the synthetic fixture.
