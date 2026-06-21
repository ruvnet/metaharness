# ADR-161: ruVector Memory Tiers — typed, depth-controlled recall

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-MEMORY-TIERS`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Generalize the existing `RuvSecurityMemory` into five typed, depth-controlled memory tiers whose recall depth is a mutatable genome policy.
**Related**: ADR-074 (ruVector memory fabric), ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-082 (expected gains + effective-performance), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-156 (umbrella — "mutate structured policies, not prompts")

> We borrow the **CrewAI unified-memory pattern** — working memory, short-term and long-term memory, a knowledge layer, guardrails, and observability composed inside a Flow — and we copy the *pattern*, not the product. CrewAI proves that an agent improves when recall is *typed* (different memory kinds for different purposes) and *budgeted* (you do not pour every memory into every step). Darwin Mode already has a single learning store, `RuvSecurityMemory` (ADR-074/155); this ADR factors it into five named tiers and makes *how deep each tier is read* a structured policy that Darwin Mode evolves. The thesis holds throughout: **the foundation model stays frozen; the harness evolves; the proof is in replay**, and **Darwin Mode mutates structured policies, not prompts.** Memory depth is one of those structured policies — never a prompt edit.

## Context

`RuvSecurityMemory` (`packages/darwin-mode/src/security/memory.ts`) is already a compounding memory keyed by repo profile. It holds seven typed collections — `codeChunks`, `callgraphNodes`, `confirmedFindings`, `falsePositives`, `patches`, `genomes`, `receipts` — with deterministic embeddings (`util.embed`, no network, no weights) so retrieval is byte-reproducible. Two behaviours already make Darwin Mode compound across runs:

- **negative memory** — `falsePositiveSimilarity()` down-ranks hypotheses near past false positives via the hybrid ranker's `-0.25` term;
- **genome memory** — `seedPopulation(profile, k)` seeds a new repo's population from prior winners, ranked by repo-profile similarity.

What is missing is *typing the purpose of recall* and *controlling its depth*. Today every collection is read at a fixed `k`, and the harness has no policy knob that says "this task class needs deep repo memory but shallow mutation memory." The `HarnessGenome.contextPolicy` field (`'minimal' | 'semantic' | 'callgraph' | 'hybrid'`) already *gestures* at depth control for code retrieval, but it does not span the other memory purposes (architecture, prior winners, cost history, risk surface).

The cost argument is concrete. Re-deriving a repo's conventions, its known-dead hypotheses, or its prior winning harness from scratch means re-running frontier reasoning on every task. If memory can answer those questions cheaply and deterministically, we *replace repeated frontier reasoning with recall*. The CrewAI insight is that the win comes from recall being **typed and depth-controlled**, not from "more memory."

**Expected impact (HYPOTHESIS to validate): 15–40% fewer input tokens on repo-bound tasks.** This is a hypothesis, not a result. The acceptance test is adversarial against our own optimism: the same task suite, memory on vs. off, must show a token-cost reduction *without* reducing solve rate. A token win that costs solve rate is a regression, not a feature.

## Decision

Introduce a `MemoryTier` enum and a `memoryDepth` selector. The five tiers map onto existing `RuvSecurityMemory` collections rather than replacing them, so the fabric (ADR-074) and the frozen ranker stay intact.

```typescript
// PROPOSED: packages/darwin-mode/src/security/memory-tiers.ts

/** The five typed recall purposes (CrewAI-pattern, Darwin-typed). */
export enum MemoryTier {
  /** Current task scratch: open hypotheses, files already read this run. */
  Working = 'working',
  /** Architecture, conventions, prior failures for THIS repo profile. */
  Repo = 'repo',
  /** Prior winning genomes (= RuvSecurityMemory.seedPopulation). */
  Mutation = 'mutation',
  /** Historical cost per task class (feeds fitness costEfficiency). */
  Cost = 'cost',
  /** Files/patterns requiring review (feeds the security review gate). */
  Risk = 'risk',
}

/** How deep each tier is read. A STRUCTURED policy — part of the genome. */
export interface MemoryDepth {
  /** Per-tier top-k. 0 ⇒ tier OFF for this task class. */
  readonly [MemoryTier.Working]: number;
  readonly [MemoryTier.Repo]: number;
  readonly [MemoryTier.Mutation]: number;
  readonly [MemoryTier.Cost]: number;
  readonly [MemoryTier.Risk]: number;
}
```

The genome gains a single structured field. This is a *policy* mutation surface (ADR-071), allowlisted and clamped — never a prompt:

```typescript
// PROPOSED extension to HarnessGenome (packages/darwin-mode/src/security/types.ts)
export interface HarnessGenome {
  // ... existing fields: planner, contextPolicy, reviewerCount, retryBudget,
  //     fuzzBudgetSeconds, tools, modelMix, validationPipeline, safetyProfile ...

  /** Mutatable recall depth per memory tier. Each value clamped 0..MAX_K. */
  memoryDepth: MemoryDepth;
}
```

`contextPolicy` continues to govern *what kind* of code context is retrieved (`minimal`/`semantic`/`callgraph`/`hybrid`); `memoryDepth` governs *how much* of each typed tier is read. They compose; they do not overlap.

A thin reader sits over the existing store and exposes each tier independently and deterministically:

```typescript
// PROPOSED: TieredMemory wraps the existing RuvSecurityMemory (no fork of the fabric).
export class TieredMemory {
  constructor(private readonly mem: RuvSecurityMemory) {}

  /** Repo tier: conventions + prior failures for a repo profile. */
  recallRepo(profile: RepoProfile, k: number): RepoMemoryHit[] { /* codeChunks + falsePositives */ }

  /** Mutation tier: prior winners. Delegates to the EXISTING seedPopulation. */
  recallMutation(profile: RepoProfile, k: number): HarnessGenome[] {
    return this.mem.seedPopulation(profile, k);
  }

  /** Cost tier: historical cost per task class → feeds fitness costEfficiency. */
  recallCost(taskClass: string, k: number): CostSample[] { /* derived from receipts/RunMetrics.costUnits */ }

  /** Risk tier: files/patterns requiring review → feeds the security review gate. */
  recallRisk(profile: RepoProfile, k: number): RankedSite[] { /* confirmedFindings + riskTags */ }

  /** Drive all five tiers from one genome policy, in one deterministic call. */
  recallByDepth(depth: MemoryDepth, profile: RepoProfile, taskClass: string): TieredRecall { /* ... */ }
}
```

Tier wiring to existing machinery, made explicit:

- **Mutation memory = prior winning genomes.** `recallMutation` *is* `memory.seedPopulation()`. No new retrieval logic; just a named, depth-controlled entry point.
- **Cost memory feeds `costEfficiency`.** The `fitness()` cost term reads `RunMetrics.costUnits` against `COST_BUDGET=20` (`scoring.ts`). The Cost tier supplies the prior cost distribution per task class so the planner can avoid over-provisioning (e.g. a 5th reviewer that adds no detection benefit), which the scorer already penalizes.
- **Risk memory feeds the security review gate.** The Risk tier surfaces files/patterns near prior `confirmedFindings` and high-`riskTags` sites; these are exactly the candidates the reviewer/`decidePromotion` safety path must not skip.

All embeddings remain deterministic (`util.embed`), so every tier read is replayable from a clean checkout — the proof stays in replay.

## Consequences

**What changes.**
- The genome gains one structured, allowlisted, clamped field (`memoryDepth`); Darwin Mode now evolves recall depth per task class, learning *which task classes need which memory depth*.
- Recall becomes typed: a step asks for the Risk tier or the Mutation tier explicitly, instead of reading one undifferentiated store.
- Token spend on repo-bound tasks should drop, because recall replaces re-derivation (HYPOTHESIS: 15–40%).

**What does not change.**
- The foundation model stays frozen. No prompt is mutated; `memoryDepth` is structured policy.
- `RuvSecurityMemory`, the seven collections, the hybrid ranker weights (`HYBRID_WEIGHTS`), and `util.embed` are untouched. `TieredMemory` is a read-side wrapper.
- The frozen scorer (`fitness()`, `findingScore()`) and the bootstrap promotion gate (`stats.ts`) are unchanged; memory cannot re-grade itself.
- `safetyProfile: 'strict-defensive'` and `exploitCodeAllowed: false` invariants are unaffected.

**What hurts.**
- More knobs widen the mutation search space; `memoryDepth` must be clamped (`0..MAX_K`) and allowlisted (ADR-071) or evolution will waste budget on absurd depths.
- A tier read at high `k` injects more context — token savings are not monotonic in depth. The A/B gate exists precisely to catch a depth setting that spends tokens without improving solve rate.
- Cost-tier samples are only as honest as the receipts they derive from; stale cost memory can mis-budget. Cost samples must carry the corpus/version they were measured on.

## Alternatives Considered

1. **Keep a single untyped memory, tune one global `k`.** Rejected: the whole CrewAI lesson is that *typed* recall beats undifferentiated recall, and a global `k` cannot say "deep repo, shallow mutation" for a given task class.
2. **Encode memory hints in the prompt ("remember that...").** Rejected outright: violates "mutate structured policies, not prompts." Prompt-encoded memory is non-replayable and non-auditable.
3. **A separate vector DB per tier.** Rejected as premature: it forks the ADR-074 fabric and breaks the deterministic-embedding replay guarantee. Tiers are *views* over the existing collections; we can shard later if a tier outgrows the store.
4. **Make `contextPolicy` carry depth too.** Rejected: `contextPolicy` is about retrieval *kind*; overloading it with depth across five purposes would make a single enum non-orthogonal and hard to mutate cleanly.

## Test Contract

These operationalize the acceptance test ("memory must reduce token cost WITHOUT reducing solve rate") as named, deterministic tests under `packages/darwin-mode/src/security/`.

- **`memory_tiers_ab_token_cost_reduces`** — Run the same task suite (default corpus) twice with a fixed genome: once with all `memoryDepth` tiers at their evolved depth ("on"), once with every tier at `0` ("off"). Assert input-token cost (proxied by `RunMetrics.costUnits` against `COST_BUDGET`) is strictly lower with memory on. Seeded; byte-reproducible.
- **`memory_tiers_ab_solve_rate_non_decreasing`** — Same A/B, assert solve rate (true-positive rate via `fitness()`) with memory on is `>=` solve rate with memory off, within the bootstrap tolerance from `stats.ts`. A token win that regresses solve rate FAILS.
- **`memory_tiers_isolation_deterministic`** — Each tier is retrievable independently: `recallRepo`, `recallMutation`, `recallCost`, `recallRisk` each return only their tier's payloads, and two calls with the same inputs return identical results (deterministic embeddings).
- **`mutation_tier_equals_seed_population`** — Assert `recallMutation(profile, k)` returns exactly `mem.seedPopulation(profile, k)` (the tier is a named view, not a reimplementation).
- **`cost_tier_feeds_cost_efficiency`** — Assert that Cost-tier samples used by the planner are drawn against the same `COST_BUDGET`/`TIME_BUDGET` scale the frozen `fitness()` grades on, so a planner cost estimate and the benchmark grade cannot diverge.
- **`memory_depth_is_clamped`** — Mutating `memoryDepth` beyond `0..MAX_K` is clamped, never accepted raw (ADR-071 allowlist discipline).

## Reference implementation

A dependency-free, deterministic reference lives in the `@metaharness/projects` package (committed this session; 117 passing tests across the package). Module: `packages/projects/src/memory-tiers.ts` (+ `__tests__/memory-tiers.test.ts`, `bench/memory-tiers.bench.mjs`). It implements the five isolated tiers, `TieredMemory`, and mutatable depth. The bench writes a receipt to `packages/projects/bench/results/memory-tiers.json`. Measured there — synthetic, deterministic simulation, not field data — ~13.6% input tokens saved with solve rate unchanged. NOTE: `TieredMemory` (mutation tier) now also backs the self-learning discovery loop (`src/learning-loop.ts`, ADR-167); a single non-deterministic real-LLM run there showed 95.7% cost reduction from escalate-once-to-learn-then-reuse.

## References

- CrewAI — unified memory (working / short-term / long-term), knowledge sources, guardrails, and observability composed in Flows. Pattern borrowed; product not used. (https://docs.crewai.com/concepts/memory)
- ADR-074 — ruVector memory fabric (the store this ADR tiers).
- ADR-070 / ADR-071 — Darwin Mode head; mutation surfaces + allowlist (`memoryDepth` is an allowlisted policy surface).
- ADR-072 — frozen scorer/promotion (memory cannot re-grade itself).
- ADR-082 — expected gains + effective-performance (token-cost framing).
- ADR-153 — agentic-loop architecture (where tiered recall is consumed per step).
- ADR-155 — Darwin Shield (`RuvSecurityMemory`, `seedPopulation`, hybrid ranker).
- ADR-156 — umbrella thesis: mutate structured policies, not prompts.
