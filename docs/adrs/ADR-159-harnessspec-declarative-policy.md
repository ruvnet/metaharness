# ADR-159: HarnessSpec — a declarative, mutatable harness policy

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `HARNESS-SPEC`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: A declarative spec format for the evolvable harness (roles, steps, branches, budgets, guards, memory, evaluators, rollback) that round-trips with the existing `HarnessGenome`
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-073 (archive + selection), ADR-074 (ruVector memory fabric), ADR-077 (DGM), ADR-079 (SGM statistical gates + risk budget), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-156 (borrowed-pattern integration program), ADR-160 (Escalation Scheduler — bounded loops)

> We borrow the **AgentSPEX explicit-graph specification** pattern: a typed, declarative description of an agent program — roles, typed steps, branching, loops, parallel execution, explicit state, checkpointing, verification, and logging — where the control flow is *written down* rather than left implicit in reactive prompting. We copy the **pattern**, not the product: HarnessSpec is a native Darwin Mode artifact, validated against our own schema and scored by our own frozen `fitness()`. This ADR is load-bearing for the program thesis — **the foundation model stays frozen; the harness evolves; the proof is in replay** — because it makes "the harness" a concrete, serializable, diffable object. And it keeps faith with **Darwin Mode mutates structured policies, not prompts**: the existing `HarnessGenome` is already a structured policy; HarnessSpec is its full declarative generalization.

## Context

Darwin Mode already mutates a structured policy. `packages/darwin-mode/src/security/types.ts` defines `HarnessGenome`:

```ts
export interface HarnessGenome {
  id: string;
  parentId?: string;
  planner: 'file-first' | 'sink-first' | 'diff-first' | 'callgraph-first' | 'risk-first' | 'memory-first';
  contextPolicy: 'minimal' | 'semantic' | 'callgraph' | 'hybrid';
  reviewerCount: number;     // clamp 1..5
  retryBudget: number;       // clamp 1..6
  fuzzBudgetSeconds: number; // clamp 10..600
  tools: SecurityTool[];
  modelMix: string[];
  validationPipeline: string[];
  safetyProfile: 'strict-defensive'; // never mutated
}
```

`genome.ts` (`mutate`, `crossover`, `seedPopulation`, `baselineGenome`) perturbs this object inside hard bounds (`BOUNDS`), `evolve.ts` (`evolve`, `ScoredGenome`, `EvolveResult.lineage`) drives population search, and `scoring.ts` (`fitness`, `FitnessBreakdown`, `COST_BUDGET=20`, `TIME_BUDGET=5`) grades it. This is good — but the genome is a *flat knob bag*, not a program. It says how big a budget is, not what the steps are, where the branches go, which guard fires on which condition, or how to roll back a failed attempt. Today that structure lives implicitly in `swarm.ts` and `agentic.ts`; it is not exportable, not diffable, and not independently replayable.

Three problems follow:

1. **Reproducibility is partial.** `stats.ts` already gives byte-reproducible *verdicts* (seeded `mulberry32`). But there is no single artifact that captures the *whole* harness program such that a clean checkout can replay a run end-to-end from it.
2. **Mutation safety is coarse.** A flat genome makes it hard to say "you may reorder these steps but never delete this guard." The graph structure is where most of the safety surface lives.
3. **Enterprise review is hard.** Reviewers want to read *what the harness does* as a document, not reverse-engineer it from TypeScript.

AgentSPEX's answer to the same problem in agent frameworks is an explicit graph spec. We adopt that shape. The spec to expand (verbatim intent): *HarnessSpec — a declarative spec for roles, steps, branches, tools, budgets, guards, memory, evaluators, rollback. Darwin Mode should mutate structured specs, not random prompt blobs. Expected impact: better reproducibility, safer mutation, easier enterprise review. Acceptance test: every evolved harness can be exported as a HarnessSpec; every HarnessSpec can be replayed deterministically with fixed seeds and fixed model outputs.* The expected-impact claims are **hypotheses to validate**, not established facts; the Test Contract operationalizes the acceptance test as the validation.

## Decision

Introduce a **proposed** module `packages/darwin-mode/src/security/harness-spec.ts` (new; clearly proposed) defining `HarnessSpec` as the full declarative generalization of `HarnessGenome`, plus a lossless round-trip `genomeToSpec` / `specToGenome`. The genome remains the unit Darwin mutates; the spec is its canonical serialization and the artifact enterprise review and replay consume.

```ts
// PROPOSED — packages/darwin-mode/src/security/harness-spec.ts
import type { HarnessGenome, SecurityTool } from './types.js';

/** A named participant in the harness program (maps to swarm.ts agents). */
export interface SpecRole {
  id: string;
  kind: 'planner' | 'retriever' | 'analyzer' | 'fuzzer' | 'reviewer' | 'patcher' | 'safety-gate';
  model?: string; // drawn from genome.modelMix; frozen — never trained
}

/** A typed step in the explicit graph (AgentSPEX pattern). */
export interface SpecStep {
  id: string;
  role: string;                 // SpecRole.id
  op: 'profile' | 'rank' | 'retrieve' | 'hypothesize' | 'static' | 'fuzz' | 'repro-test' | 'review' | 'patch' | 'gate' | 'score';
  /** Step ids that must complete before this one (the graph edges). */
  dependsOn: string[];
  /** Steps runnable concurrently with this one (explicit parallelism). */
  parallelWith?: string[];
  /** Branch: pick the next step by a typed predicate, never by free text. */
  branch?: { when: SpecPredicate; goto: string; else?: string };
  /** Bounded loop over this step (ties to ADR-160 SchedulerPolicy). */
  loop?: { maxIterations: number; until: SpecPredicate };
  /** Checkpoint state after this step (enables rollback). */
  checkpoint?: boolean;
}

/** Typed branch/guard predicate — no prompt blobs (program thesis). */
export type SpecPredicate =
  | { metric: 'confidence' | 'toolAgreements' | 'reproduced' | 'unsafeOutputs'; op: '>=' | '<=' | '>' | '<' | '=='; value: number }
  | { flag: 'security_review_required' | 'batch_eval' | 'cache_repo_context'; equals: boolean };

/** Budgets — the same numeric envelope genome.ts/BOUNDS already clamps. */
export interface SpecBudgets {
  reviewerCount: number;      // 1..5  (genome.reviewerCount)
  retryBudget: number;        // 1..6  (genome.retryBudget)
  fuzzBudgetSeconds: number;  // 10..600 (genome.fuzzBudgetSeconds)
  retrievalTopK: number;      // proposed retrieval knob
  frontierEscalationThreshold: number; // confidence below which a cheap model escalates to frontier
  /** Mirrors scoring.ts COST_BUDGET / TIME_BUDGET — replay grades on the same scale. */
  costBudget: number;         // default 20
  timeBudget: number;         // default 5
}

/** Guards — security invariants that may NOT be mutated away. */
export interface SpecGuards {
  safetyProfile: 'strict-defensive';   // immutable (mirrors HarnessGenome)
  securityReviewRequired: boolean;      // policy.detectUnsafe gate must run
  failClosedOnSecurityUncertainty: true; // ties to ADR-160 + ADR-079
  exploitCodeAllowed: false;            // structural invariant (Finding.exploitCodeAllowed)
}

/** Memory tiers (ADR-074 ruVector fabric / RuvSecurityMemory). */
export interface SpecMemory {
  cacheRepoContext: boolean;
  tiers: Array<'genome' | 'finding' | 'false-positive' | 'patch-example'>;
}

/** Evaluators — frozen graders (scoring.ts); the spec may NOT redefine them. */
export interface SpecEvaluators {
  fitness: 'frozen';   // scoring.ts fitness() — referenced, never inlined
  promotion: 'sgm-bootstrap'; // stats.ts decidePromotion / bootstrapDelta
}

export interface SpecRollback {
  onFailure: 'restore-checkpoint' | 'abort';
  retainReceipt: boolean; // always keep the BenchmarkReceipt for replay
}

export interface HarnessSpec {
  schemaVersion: 1;
  id: string;
  parentId?: string;
  roles: SpecRole[];
  steps: SpecStep[];      // the explicit graph
  budgets: SpecBudgets;
  guards: SpecGuards;
  memory: SpecMemory;
  evaluators: SpecEvaluators;
  rollback: SpecRollback;
  /** Free-form provenance; never load-bearing for replay. */
  provenance?: { codename: string; createdAt: string };
}
```

### Round-trip: HarnessGenome ⇄ HarnessSpec

The genome is the mutable core; the spec is its faithful expansion. `genomeToSpec(g)` projects the genome's `planner`, `contextPolicy`, `validationPipeline`, `tools`, `modelMix`, and the three clamped budgets into roles + a canonical step graph + budgets. `specToGenome(s)` collapses the graph back to the flat genome. The contract: **`specToGenome(genomeToSpec(g))` is deep-equal to `g`** for every valid genome. The default step graph emitted by `genomeToSpec` is exactly the `swarm.ts` pipeline order (`profile → rank → context → hypotheses → static + fuzz → review → gate → patch → score`), so the projection is information-preserving.

### Worked JSON example (policy mutation surface)

```json
{
  "schemaVersion": 1,
  "id": "g3_v2_1a",
  "parentId": "g2_v0_9",
  "roles": [
    { "id": "planner",  "kind": "planner",  "model": "claude-cheap" },
    { "id": "reviewer", "kind": "reviewer", "model": "claude-frontier" },
    { "id": "gate",     "kind": "safety-gate" }
  ],
  "steps": [
    { "id": "profile", "role": "planner", "op": "profile", "dependsOn": [] },
    { "id": "retrieve", "role": "planner", "op": "retrieve", "dependsOn": ["profile"],
      "checkpoint": true },
    { "id": "review", "role": "reviewer", "op": "review", "dependsOn": ["retrieve"],
      "branch": { "when": { "metric": "confidence", "op": "<", "value": 0.7 },
                  "goto": "review", "else": "gate" },
      "loop": { "maxIterations": 4, "until": { "metric": "confidence", "op": ">=", "value": 0.7 } } },
    { "id": "gate", "role": "gate", "op": "gate", "dependsOn": ["review"] },
    { "id": "score", "role": "planner", "op": "score", "dependsOn": ["gate"] }
  ],
  "budgets": {
    "reviewerCount": 3, "retryBudget": 4, "fuzzBudgetSeconds": 120,
    "retrievalTopK": 8, "frontierEscalationThreshold": 0.7,
    "costBudget": 20, "timeBudget": 5
  },
  "guards": {
    "safetyProfile": "strict-defensive",
    "securityReviewRequired": true,
    "failClosedOnSecurityUncertainty": true,
    "exploitCodeAllowed": false
  },
  "memory": { "cacheRepoContext": true, "tiers": ["genome", "finding", "false-positive"] },
  "evaluators": { "fitness": "frozen", "promotion": "sgm-bootstrap" },
  "rollback": { "onFailure": "restore-checkpoint", "retainReceipt": true }
}
```

The mutatable policy surface — `planner_model` cheap/frontier (`roles[].model`), `retrieval_top_k` (`budgets.retrievalTopK`), `max_retries` (`budgets.retryBudget`), `frontier_escalation_threshold` (`budgets.frontierEscalationThreshold`), `security_review_required` (`guards.securityReviewRequired`), `batch_eval` and `cache_repo_context` (`memory.cacheRepoContext`) — is all addressable as named, typed spec fields. Darwin mutates the genome; `genomeToSpec` re-emits the spec; nothing is a prompt blob.

## Consequences

### What changes
- The evolvable harness gains a canonical, serializable, diffable form. `EvolveResult.lineage` can be rendered as a sequence of HarnessSpec diffs.
- Replay becomes spec-driven: given a HarnessSpec, a fixed seed, and fixed (recorded) model outputs, a run is reproducible end-to-end — the `BenchmarkReceipt.inputHash` extends to cover the spec.
- Mutation safety becomes structural: `guards` (and `safetyProfile`) are non-mutatable spec regions; the allowlist logic of ADR-071 gains a typed home.

### What does not change
- `scoring.ts` stays frozen — `evaluators` *references* `fitness()`; it never inlines or redefines it. A genome (or spec) still cannot re-grade itself.
- `genome.ts` bounds (`reviewerCount 1..5`, `retryBudget 1..6`, `fuzzBudgetSeconds 10..600`) and `safetyProfile: 'strict-defensive'` remain the source of truth; `SpecBudgets`/`SpecGuards` mirror, never widen them.
- The promotion gate (`stats.ts` `decidePromotion`/`bootstrapDelta`, ADR-079/072) is unchanged. The model stays frozen.

### What hurts
- Two representations (genome + spec) means a real maintenance cost: the round-trip property must be enforced by test, or they drift. We accept this; the round-trip test is the guardrail.
- The default step graph hard-codes the `swarm.ts` pipeline order. If `swarm.ts` reorders, `genomeToSpec` must follow — coupling we make explicit rather than hidden.
- Spec verbosity: a HarnessSpec is far larger than a genome. Mitigated by keeping the genome the *mutated* object and treating the spec as a derived/exported view.

## Alternatives Considered

1. **Keep the flat `HarnessGenome` only.** Simplest, already shipping. Rejected: it cannot capture branches, loops, guards, or rollback, so it fails the "replay the whole harness program" half of the acceptance test and the enterprise-review goal.
2. **Mutate prompt templates directly (reactive prompting).** This is exactly what the program thesis forbids — *Darwin Mode mutates structured policies, not prompts*. Prompt blobs are unreviewable, non-diffable, and unsafe to mutate. Rejected on thesis grounds.
3. **Adopt an external agent-graph DSL (LangGraph/AgentSPEX product) wholesale.** We borrow the *pattern* (explicit typed graph) but a foreign runtime would not honor our frozen scorer, our `BOUNDS`, or our `strict-defensive` guard, and would import a dependency surface we cannot security-review. Rejected: copy the pattern, not the product.
4. **Store the spec as opaque JSON with no TS types.** Cheap, but loses compile-time guarantees on guards/budgets — the safety-critical fields. Rejected.

## Test Contract

London-school unit tests (collaborators are the genome/spec mappers; frozen `fitness`/`stats` are referenced, not exercised here) plus integration tests. Proposed file `packages/darwin-mode/src/security/__tests__/harness-spec.test.ts`.

- **`export-round-trip identity`** (unit): for every genome produced by `seedPopulation(baselineGenome(), 32, seed)` and by `mutate(...)`, assert `specToGenome(genomeToSpec(g))` deep-equals `g`. Property-style over seeds 0..9. This operationalizes *"every evolved harness can be exported as a HarnessSpec."*
- **`deterministic-replay byte-identical`** (integration): build a spec, fix the seed and a recorded fixed model-output transcript, run the spec twice; assert the two `BenchmarkReceipt`s (including `inputHash`) are byte-identical. This operationalizes *"every HarnessSpec can be replayed deterministically with fixed seeds and fixed model outputs."*
- **`schema-validation rejects malformed spec`** (unit): feed specs with (a) `guards.safetyProfile !== 'strict-defensive'`, (b) `budgets.retryBudget = 7` (out of `BOUNDS`), (c) a `steps[].dependsOn` cycle, (d) `guards.exploitCodeAllowed = true`; assert each is rejected with a typed validation error. Guards and bounds are non-negotiable.
- **`mutation preserves guards`** (unit): for any `g` and any mutation, `genomeToSpec(mutate(g, ...)).guards` is unchanged from the parent's guards — the non-mutatable region stays fixed.
- **`spec lineage is diffable`** (integration): run `evolve` for 3 cycles, export each champion ancestor via `genomeToSpec`, assert consecutive specs differ only in mutated fields and never in `guards`.

## Reference implementation

A dependency-free, deterministic reference lives in the `@metaharness/projects` package (committed this session; 117 passing tests across the package). Module: `packages/projects/src/harness-spec.ts` (+ `__tests__/harness-spec.test.ts`, `bench/harness-spec.bench.mjs`). It implements `HarnessSpec`, the lossless `genomeToSpec`/`specToGenome` round-trip, `validateSpec`, and `replaySpec`. The bench writes a receipt to `packages/projects/bench/results/harness-spec.json`. Measured there — synthetic, deterministic simulation, not field data — the round-trip is lossless, replay is deterministic across 256 seeds, and a policy mutation is observable as a hash delta. Optimization: per-step replay hashes are memoized.

## References

- AgentSPEX — explicit-graph agent specification (typed steps, branching, loops, parallel execution, explicit state, checkpointing, verification, logging). Pattern source; product not imported.
- ADR-155 (Darwin Shield) — `HarnessGenome`, `swarm.ts` pipeline, `scoring.ts` frozen `fitness()`, safety gate.
- ADR-071 (mutation surfaces + allowlist) — the non-mutatable region `guards` formalizes.
- ADR-072 (frozen scorer/promotion) and ADR-079 (SGM gates) — `evaluators` references these; never redefines them.
- ADR-073 (archive) / ADR-074 (ruVector memory fabric) — `SpecMemory` tiers (`RuvSecurityMemory`).
- ADR-153 (agentic-loop architecture) — bounded loops `SpecStep.loop` formalizes; see ADR-160.
- ADR-156 (borrowed-pattern integration program) — umbrella: *mutate structured policies, not prompts.*
