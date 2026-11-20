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

Install `@ruvector/rvf` (and a working native runtime) separately. The package is not required by Darwin.

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

## Experimental append-only journal

`SimJournal` is now exported as a separate **opt-in persistence primitive**, with one fsynced JSONL event per append, hash chain verification, strict shared SIM schema validation, and incomplete-tail recovery. The existing `SimMemory` snapshot remains the default for `evolve()`. This separation is intentional: no transparent migration, shared-writer guarantee, or automatic journal-to-SIM adapter has been validated yet.

```ts
import { SimJournal } from '@metaharness/darwin';
const journal = new SimJournal('/safe-owner-data/optimizer-events.jsonl');
const recovery = await journal.load();
console.log(recovery); // { records, recoveredTailBytes }
await journal.append(validatedSimAttempt);
```

Never point two processes at the same journal. Only a final unterminated record is recoverable; complete corrupt records fail closed. Do not treat a hash chain as an authenticated signature or durable multi-node transaction. Append fsync guarantees rely on the underlying filesystem's fsync implementation and hardware. A future checkpoint/compaction layer must preserve the verifiable chain head and audit evidence.

Reproduce local synthetic persistence measurements:

```bash
npm run bench:sim-journal -w @metaharness/darwin
SIM_BENCH_RECORDS=2000 node packages/darwin-mode/bench/sim-journal.mjs
```

On one ruOS Software Factory run, the 2,000-record snapshot baseline sustained 82 writes/s and the fsynced journal sustained 1,831 writes/s (22.33 times faster). This is a **single-machine microbenchmark**, not a 100,000-record endurance or crash-power-loss test. Journal replay still reads and validates the complete history, and the journal is not yet used by the default Darwin integration.

## Verification and operational reality

```bash
npm run lint -w @metaharness/darwin
npx vitest run packages/darwin-mode/__tests__/sim-memory.test.ts packages/darwin-mode/__tests__/sim-evolve.test.ts
npm run bench:sim -w @metaharness/darwin
```

The benchmark is a fixed 40-record, four-query **synthetic retrieval experiment** comparing no history, full bounded history, and retrieved history. It measures context precision, recall in budget, latency and approximate tokens only, not AI model improvement. The same fixed fixtures and seeds are used for all three arms.

**Failure modes:** Cross-model transfer is only a prior and must be independently tested. Stale or poisoned records may bias proposals. The local hash chain detects accidental corruption, not a malicious writer. Persistence is safe for a single writer; do not share a snapshot across processes without a real lock/transaction layer. Index ingestion errors fail explicitly rather than silently claiming vector retrieval. External evaluation data stays out of SIM, which stores only evidence references and final measured scores. No secrets or raw hidden tests should be stored in the record.

**Acceptance beyond this PR:** independent model evals with sealed heldout suites, matching candidate counts, budgets and model versions, reproducible negative-transfer ablations, signed receipts and at least 2 held out score points gained without security or cost regressions. No such improvement is claimed from the synthetic fixture.
