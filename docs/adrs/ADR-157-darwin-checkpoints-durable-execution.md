# ADR-157: Darwin Checkpoints — durable, resumable mutation runs

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-CHECKPOINT`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Durable, crash-resumable evolution runs with a content-addressed model/tool-call cache, so a killed run resumes without re-spending frontier calls and replays to identical fitness.
**Related**: ADR-155 (Darwin Shield), ADR-156 (borrowed-pattern integration program — "mutate structured policies, not prompts"), ADR-073 (archive + selection), ADR-074 (ruVector memory fabric), ADR-072 (frozen scorer/promotion), ADR-070 (Darwin Mode head), ADR-079 (SGM statistical gates + risk budget), ADR-153 (agentic-loop architecture)

> We borrow the **durable execution** pattern from **LangGraph** (durable, stateful graph execution with persistence, streaming, human-in-the-loop, and long-running agents that survive process restarts). We copy the *pattern*, not the product: no LangGraph runtime, no Python graph engine, no checkpointer library is imported. We graft its idea — every step commits its state so the run is a resumable sequence rather than one fragile process — onto Darwin Shield's existing per-cycle loop in `packages/darwin-mode/src/security/evolve.ts`. Consistent with the program thesis: **the foundation model stays frozen; the harness evolves; the proof is in replay.** And consistent with ADR-156: **Darwin Mode mutates structured policies, not prompts** — so a checkpoint is a record of structured `HarnessGenome` evaluations, not a conversation transcript.

## Context

`evolve()` in `src/security/evolve.ts` runs `cfg.cycles` (default 50) generations over a population of `cfg.population` (default 16) genomes. Each cycle scores every genome with `evaluate()` → `runSwarm()` → `fitness()`, producing a `ScoredGenome` (`{ genome, breakdown }`). With the real oracles of Phase 2 (`semgrep-oracle.ts`, `fuzz-oracle.ts`, `real-loop.ts`, `real-evolve.ts`), a single `runSwarm` can take minutes (fuzzing up to `fuzzBudgetSeconds` ≤ 600 per candidate) and can issue real frontier model calls via `modelMix`. A 50-cycle × 16-genome run is ~800 evaluations; a crash at evaluation 400 today restarts from cycle 0 and re-pays for every frontier call already made.

Three problems follow, all of which the durable-execution pattern addresses:

1. **No resumability.** A killed process loses all in-cycle progress. The only durable state is `archive.json` written by the kernel loop, and the security loop is in-memory.
2. **No frontier-call reuse.** `evaluate()` is deterministic for a fixed `(genome, corpus, memory, seed)` — `hashInputs()` in `swarm.ts` already proves this by hashing exactly those inputs — yet a resumed run recomputes everything, re-spending money on calls whose output is already determined.
3. **No crash forensics.** When an evaluation fails (oracle timeout, OOM, network) there is no record of *which* step failed or what to roll back to.

The borrowed source's expected impact — **5–15% cost reduction on long runs** and **20–40% reliability improvement for multi-step tasks** — we treat as **hypotheses to validate** against our own corpus, not established facts. The Test Contract operationalizes the acceptance test that decides them.

## Decision

Add a **checkpoint layer** (PROPOSED new module `src/security/checkpoint.ts`) that the existing `evolve()` loop calls after each `ScoredGenome` is produced, plus a **content-addressed call cache** (PROPOSED `src/security/call-cache.ts`) keyed by `(genomeId, step, inputHash)` so resumed runs reuse frontier and tool outputs instead of re-issuing them.

### Checkpoint record

A checkpoint is written per evaluation (one genome, one cycle). It records the structured outcome — never a prompt.

```ts
// PROPOSED — src/security/checkpoint.ts
import type { FitnessBreakdown } from './scoring.js';
import type { RunMetrics } from './types.js';

export interface Checkpoint {
  /** Stable run id (one evolve() invocation). */
  runId: string;
  cycle: number;                 // 0..cfg.cycles-1
  genomeId: string;              // HarnessGenome.id
  parentId?: string;             // HarnessGenome.parentId — lineage edge
  /** The deterministic input fingerprint (== swarm.hashInputs). */
  inputHash: string;
  /** What this evaluation step recorded. */
  step: 'baseline' | 'evaluate' | 'promote';
  stepResult: 'ok' | 'failed';
  /** Folded run metrics (source of the fitness cost inputs). */
  metrics: RunMetrics;
  /** The frozen scorer's verdict for this genome. */
  breakdown: FitnessBreakdown;
  /** Accounting for the run, surfaced by the call cache. */
  toolCalls: number;
  modelCalls: number;
  /** Deterministic cost proxy (== swarm.costOf for sim; metered USD for real-loop). */
  costUnits: number;
  /** Present iff stepResult === 'failed'. */
  failureReason?: string;
  /** The checkpoint to resume FROM if this step is rolled back. */
  rollbackPointer?: { cycle: number; genomeId: string };
  /** Fixed seed in force (cfg.seed ?? 0) — pins deterministic replay. */
  seed: number;
  createdAt: string;             // fixed epoch in sim mode for byte-stable receipts
}
```

The invariant that makes resume safe: `Checkpoint.inputHash === hashInputs(genome, corpus, taskId, seed)` from `swarm.ts`. A checkpoint is **valid for reuse** only when its `inputHash` matches a recomputed hash of the same genome — so changing the corpus, seed, or any genome knob invalidates the cached result automatically.

### Content-addressed call cache

```ts
// PROPOSED — src/security/call-cache.ts
export interface CallCacheKey {
  genomeId: string;
  step: string;       // e.g. 'model:<modelId>' | 'tool:<SecurityTool>'
  inputHash: string;  // hash of the exact call inputs
}

export interface CallCacheEntry<T = unknown> {
  key: CallCacheKey;
  output: T;          // the frontier/tool output, content-addressed
  costUnits: number;  // charged once; replays charge 0
  createdAt: string;
}

export interface CallCache {
  get<T>(key: CallCacheKey): CallCacheEntry<T> | null;
  put<T>(entry: CallCacheEntry<T>): void;
  /** Accounting: hits never re-issue a frontier call. */
  stats(): { hits: number; misses: number; reusedCostUnits: number };
}
```

Because `runSwarm` is deterministic for fixed inputs, a cache hit is provably substitutable for the real call: the output is a pure function of `(genomeId, step, inputHash)`. On resume, every model/tool call first consults the cache; a hit returns the stored output and charges **0** `costUnits`; a miss issues the real call and `put`s the result. The frozen-model thesis makes this sound — a frozen model's output for fixed inputs does not drift.

### Where checkpoints persist

Two tiers, reusing existing fabric, no new store:

- **SQLite archive (ADR-073).** Checkpoints persist alongside the lineage tree as a `checkpoints` table keyed by `(runId, cycle, genomeId)`. This is the durable, queryable system of record and the rollback source.
- **ruVector (ADR-074).** The `CallCacheEntry` outputs are content-addressed and stored in the ruVector fabric (already the home for `SecurityVectorMeta` carrying `genomeId`), so frontier outputs are reused across *runs*, not just within one — the compounding property ADR-074 already promises for findings, extended to calls.

### How `evolve.ts` writes a checkpoint

The change to `src/security/evolve.ts` is local and additive. Today the per-cycle loop does:

```ts
const scored = population.map((g) => { evaluations += 1; return evaluate(g, cfg, `cycle-${cycle}`); });
```

The PROPOSED durable form, after computing each `ScoredGenome`, commits a checkpoint and threads the cache through `evaluate()`:

```ts
// PROPOSED loop body (illustrative)
const scored = population.map((g) => {
  const recovered = store.find(runId, cycle, g.id);     // resume: skip recomputation
  if (recovered && recovered.stepResult === 'ok') return recovered.scored;
  evaluations += 1;
  const sg = evaluate(g, cfg, `cycle-${cycle}`, { cache });   // cache → reuse frontier calls
  store.write(toCheckpoint(runId, cycle, sg, cache.stats())); // durable after EVERY genome
  return sg;
});
```

`store.write` is the durable boundary: after every genome, not every cycle. Resume reads the checkpoint table, replays completed `(cycle, genomeId)` pairs from cache, and continues from the first missing one. The baseline (`evaluate(base, cfg, 'baseline')`) and the optional `decidePromotion()` gate (`stats.ts`, ADR-079) each get their own `step` value (`'baseline'`, `'promote'`) so the SGM risk budget is charged exactly once even across a crash.

### Deterministic replay tie-in

Replay determinism already holds in the engine: `seed = cfg.seed ?? 0` drives `makeRng`, `mutate`, `crossover`, and `bootstrapDelta`; `hashInputs` pins the input fingerprint. Checkpoints carry `seed` and `inputHash` so a resumed run uses the identical RNG stream and the identical cache keys. The proof obligation is the kill/resume determinism test below.

## Consequences

### What changes
- `src/security/evolve.ts` gains a checkpoint write after each `ScoredGenome` and a resume path that skips completed evaluations.
- A new durable `checkpoints` table in the ADR-073 SQLite archive and content-addressed call outputs in the ADR-074 ruVector fabric.
- `evaluate()` / `runSwarm()` accept an optional `CallCache` so the real oracles (`semgrep-oracle.ts`, `fuzz-oracle.ts`, `real-loop.ts`) consult it before issuing a frontier or tool call.
- Long runs become resumable; expensive frontier calls are reused within and across runs.

### What does not change
- The frozen scorer (`fitness()` in `scoring.ts`) is untouched — checkpoints record its output, never recompute or re-grade it.
- `HarnessGenome` and `safetyProfile: 'strict-defensive'` are untouched; checkpoints store ids and metrics, not new mutable surfaces.
- Determinism guarantees from `hashInputs`/seeded RNG are preserved; the cache is a memoization of an already-pure function.
- The safety gate (`policy.ts` `gateOutputs`/`detectUnsafe`) still runs on every emitted finding — cached outputs are *findings already gated at write time*, and are re-gated on read to defend against a tampered cache (`unsafeOutputs` must stay 0).

### What hurts
- **Cache invalidation correctness is load-bearing.** A wrong `inputHash` (e.g. forgetting a knob in the canonical JSON of `hashInputs`) would serve a stale frontier output and silently corrupt fitness. The reconciliation discipline of ADR-158 is the cross-check.
- **Storage growth.** Per-evaluation checkpoints plus content-addressed outputs grow the archive; needs a retention/GC policy (keep champion lineage + last-N cycles).
- **A poisoned cache is a supply-chain risk.** Hence re-gating cached findings on read and content-addressing by hash so a substituted output fails its key.
- The expected 5–15% cost / 20–40% reliability figures are **unproven hypotheses** until the Test Contract passes on our corpus; we must not cite the LangGraph source's numbers as our results.

## Alternatives Considered

1. **No checkpoints; just restart.** Status quo. Rejected: re-spends every frontier call and loses long-run progress — the exact failure the source pattern fixes.
2. **Whole-process snapshot (CRIU/serialize the heap).** Rejected: brittle across Node versions, captures non-deterministic state, and does not give per-step accounting or rollback pointers.
3. **Checkpoint per *cycle* instead of per *genome*.** Cheaper writes but loses up to `population−1` evaluations on a crash and cannot reuse partial-cycle frontier calls. Rejected: defeats the cost-reduction goal mid-cycle.
4. **Import a LangGraph-style checkpointer dependency.** Rejected per ADR-156: we copy the pattern, not the product, and our state is structured genome evaluations, not a graph-of-prompts.
5. **Cache keyed by genome content hash only (no `step`).** Rejected: cannot reuse individual model/tool calls within a `runSwarm`, only whole evaluations; coarser and less effective at the per-call leaks ADR-158 targets.

## Test Contract

London-school unit tests mock the call boundary (the frontier/tool invoker) and assert on interactions; integration tests run the real deterministic sim loop.

- **`checkpoint.unit.writesAfterEachGenome`** (London) — with a mocked `CheckpointStore`, run a 1-cycle, 3-genome `evolve()`; assert `store.write` is called exactly 3 times (+1 baseline) with monotonically increasing `(cycle, genomeId)` and that each `Checkpoint.inputHash === hashInputs(genome, corpus, taskId, seed)`.
- **`callcache.unit.hitChargesZero`** (London) — with a mock invoker, prime the cache with one `CallCacheEntry`, then request the same `CallCacheKey`; assert the invoker is **not** called and `costUnits` charged is 0; request a different key and assert the invoker **is** called once.
- **`checkpoint.integration.killResumeDeterminism`** (the acceptance test) — run `evolve()` over a fixed corpus with `seed: 1` for ~100 evaluations to completion (run A). Then run again, killing the process at the halfway evaluation, and resume from the checkpoint store (run B). Assert: (a) `champion.breakdown.fitness`, full `history[]`, and `winnerLineage` are **byte-identical** between A and B; (b) the number of *real* frontier calls in B equals A minus the calls already cached at kill time — i.e. **zero duplicate model calls** post-resume; (c) every resumed `(cycle, genomeId)` came from a cache hit, not a re-issue.
- **`callcache.integration.hitAccounting`** — over a 10-cycle sim run, assert `cache.stats().hits + cache.stats().misses === totalCalls`, `misses === uniqueInputHashes`, and `reusedCostUnits === Σ(costUnits of hit entries)`; assert the second identical run is **all hits** (compounding across runs, ADR-074).
- **`checkpoint.unit.rollbackPointerOnFailure`** (London) — force `evaluate()` to throw on one genome; assert the written checkpoint has `stepResult: 'failed'`, a non-empty `failureReason`, and a `rollbackPointer` to the last `ok` checkpoint, and that resume continues from there without re-running the `ok` predecessors.
- **`checkpoint.unit.safetyReGateOnRead`** — inject a cached finding mutated to contain an unsafe pattern; assert `detectUnsafe` flags it on read, it is redacted, and `RunMetrics.unsafeOutputs` for the resumed run stays 0 (acceptance invariant preserved).
- **`checkpoint.unit.invalidationOnSeedChange`** — write checkpoints with `seed: 0`, resume with `seed: 1`; assert every cached entry is treated as a miss (inputHash mismatch) and recomputed.

## Reference implementation

A dependency-free, deterministic reference lives in the `@metaharness/projects` package (committed this session; 117 passing tests across the package). Module: `packages/projects/src/checkpoints.ts` (+ `__tests__/checkpoints.test.ts`, `bench/checkpoints.bench.mjs`). It implements `Checkpoint`, `CheckpointStore`, `CallCache`, and `runWithCheckpoints`. The bench writes a receipt to `packages/projects/bench/results/checkpoints.json`. Measured there — synthetic, deterministic simulation, not field data — resume saves ~39% cost vs restart-from-scratch at 100% reliability, and the durability guarantee holds: `maxDuplicateModelCalls = 0` (the checkpointed prefix is never re-executed on resume). Optimization: `CheckpointStore.save` is O(n) insert-in-order.

## References

- LangGraph — durable execution / persistence (checkpointers), streaming, human-in-the-loop, and long-running agents (`langchain-ai/langgraph`, LangGraph docs "Durable Execution"). Pattern borrowed: commit state per step so a run is resumable; product not imported.
- ADR-155 (Darwin Shield) — the genome, `fitness()`, `runSwarm`, `hashInputs`, the swarm loop this layer wraps.
- ADR-156 — borrowed-pattern integration program ("mutate structured policies, not prompts"); the umbrella this ADR sits under.
- ADR-073 (archive + selection) — the SQLite system of record extended with the `checkpoints` table.
- ADR-074 (ruVector memory fabric) — content-addressed cross-run call/finding cache.
- ADR-072 (frozen scorer) — the verdict checkpoints record but never recompute.
- ADR-079 (SGM statistical gates + risk budget) — `decidePromotion`/risk-budget charged exactly once across a crash via the `'promote'` step.
- ADR-158 (Darwin Trace Format & Cost Ledger) — the reconciliation discipline that cross-checks cache cost accounting.
