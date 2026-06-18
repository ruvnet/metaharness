# ADR-084: Darwin Mode — self-reflection via failure-driven mutation

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + `CodeGenerator` contract), ADR-072 (scorer + promotion), ADR-077 (DGM foundation)

> The `CodeGenerator` contract (ADR-071) always declared a reflection channel — `repoSummary`, `parentScore`, `failedTraces` — but the loop fed it nothing. This ADR records wiring that channel so a child mutation can target the parent's *actual* failures instead of mutating blind. It is the DGM "self-modify in response to evaluation" mechanism (ADR-077), at the mutation-operator level.

## Context

ADR-071 defined the pluggable mutation contract:

```ts
interface CodeGenerator {
  generateMutation(input: {
    parentCode: string; surface: MutationSurface; repoSummary: string;
    parentScore: number; failedTraces: string[];
  }): Promise<{ code: string; summary: string }>;
}
```

The `DeterministicMutator` ignores the last three fields by design (it is a seeded string-perturbation generator — reproducible, dependency-free). But `createChildVariant` **hardcoded** `repoSummary: ''`, `parentScore: 0`, `failedTraces: []` for *every* generator, including the LLM-backed `OpenRouterMutator`. So even a frontier model was asked to "improve this file" with no signal about what was wrong — it mutated blind.

DGM (ADR-077) is credible precisely because each self-modification is a *response to an empirical result*: the agent reads how it failed and edits the harness to fix that. Without the failure signal, Darwin Mode's LLM path was missing that feedback edge — it was random search wearing an LLM costume.

A second, structural reason this matters: ADR-072's scorer is ceiling-bound (every safe, test-passing variant lands at `finalScore = 0.985`). When the *quality* signal is flat, the *direction* signal (what failed, fix it) is the only usable gradient an LLM mutator has. Feeding failures is therefore not a nicety — it is the mechanism that lets a model mutator do anything better than chance.

## Decision

Carry each parent's evaluation forward and feed it into its children's mutations.

1. **`evolve()` tracks parent traces.** A `tracesById: Map<string, RunTrace[]>` is maintained alongside the existing `scoreById`, seeded with the baseline and updated as each variant commits.

2. **A pure distiller, `summarizeFailedTraces(traces): string[]`.** A trace "failed" if it exited non-zero, timed out, or tripped a safety block. Each failure becomes one compact line — `task <id>: <why> — <last stderr/stdout line, ≤160 chars>` — so the prompt stays bounded. The function is deterministic, order-preserving, no wall-clock, no I/O.

3. **`createChildVariant` gains an optional `context: MutationContext`** (`{ repoSummary?, parentScore?, failedTraces? }`, all defaulting empty). `evolve()` passes `{ repoSummary: profile.summary, parentScore: parent.finalScore, failedTraces: summarizeFailedTraces(parentTraces) }`. The `OpenRouterMutator` already renders `failedTraces` into its prompt (`Recent failures: …`), so the wiring activates immediately.

## Invariants preserved

- **Reproducibility (ADR-075).** The `DeterministicMutator` does not read the reflection fields, so its output is byte-identical to before. All prior reproducibility/e2e tests pass unchanged.
- **Safety (ADR-071).** The reflection context only shapes the *proposal*; every generated file still passes `validateGeneratedCode` before it touches disk. A failure-targeted mutation that tries to add a capability is discarded like any other.
- **Back-compat.** `context` is the 7th, optional parameter; existing call sites and tests are unaffected.

## Consequences

- The LLM mutator now performs *directed* search: "test `build` failed with `TypeError: x is not a function` → fix the planner/reviewer surface" rather than "make some change."
- Failure summaries are capped and side-effect-free, so prompt cost stays bounded and runs stay reproducible up to the model's own nondeterminism.
- This sharpens, but does not replace, the need for a real *graded* fitness (a future ADR): direction helps, but the scorer still cannot rank two passing variants. Failure-driven mutation is most valuable precisely while some tasks still fail.

## Validation

`packages/darwin-mode` — 288 tests pass (was 282; +6): `summarizeFailedTraces` (clean/exit/timeout/block/tail-cap) and `createChildVariant` context forwarding + empty-default back-compat. Shipped in the same change as the wiring.
