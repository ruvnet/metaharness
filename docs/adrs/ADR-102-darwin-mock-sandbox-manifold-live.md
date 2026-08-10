# ADR-102: Darwin Mode — deterministic surface-driven sandbox (the manifold goes live)

**Status**: Accepted (implemented + measured)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-101 (the keystone requirement — this is its Tier 1), ADR-091/092/094/097/099/100 (the now-activated stack). Recommended Priority-1 by the hourly horizon scan #2.

## Context

> ADR-101 named the keystone: traces must depend on the harness surfaces. This ADR ships the cheapest version of it — a deterministic, LLM-free, surface-driven agent-loop simulator — and **measures the manifold going live**.

## Decision

`src/mock-sandbox.ts`, selected by `EvolutionConfig.sandboxMode: 'mock'` (default `'real'` unchanged):

- `extractSurfaceParams(dir)` reads the variant's surface files with the **same regexes the `DeterministicMutator` writes** — so a mutation that bumps the retry budget or the `.slice(0,N)` window is reflected: `maxAttempts` (retryPolicy), `contextWindow` (contextBuilder), `memoryThreshold` (memoryPolicy), `planSteps` (planner).
- `simulateAgentLoop(params, task)` runs a scripted agent loop: a task is solved only if the agent **sees enough context** (`contextWindow ≥ requiredContext`) **and retries past** the task's failing attempts (`maxAttempts > failAttempts`). It logs plan steps, context builds, and retry decisions, and sets `durationMs` from the surface params (retries × backoff + window) — **deterministic, so reproducible** (no wall-clock).
- `DEFAULT_MOCK_TASKS` is a graded easy→hard suite (difficulty 1/3/5), which also feeds the curriculum (ADR-097).
- `runVariantTasksMock` wraps this into ordinary `RunTrace`s; `evolve()` uses it in mock mode. No new dependencies, no compilation, no LLM, no shell.

## Measured result (real, 2026-06-18) — the manifold is live

Same `evolve` run (5 gens, 4 children, seed 5, `selection: behavioral-diversity`) under both modes (`bench/results/manifold-live.json`):

| mode | distinct niches | nicheEntropy | distinct finalScores |
|---|--:|--:|---|
| real (repo test cmd) | 1 | **0** | [0.985] — flat |
| **mock (surface-driven)** | 2 | **0.6899** | **[0.435, 0.618, 0.802]** |

Mock mode makes **both** the behavioural manifold (entropy 0 → 0.69) **and** the fitness signal (flat 0.985 → a 0.43–0.80 spread) non-degenerate. That spread is the thing the entire selection stack was waiting for: clade metaproductivity (ADR-094), niche steering (ADR-092), curriculum escalation (ADR-097), FDR control (ADR-096), Pareto (ADR-100), and the mutator bandit all now receive real signal. The audit's success criterion from ADR-099 (`nicheEntropy > 0`) is met.

## Honest scope

- This is **Tier 1**: a *simulated* agent loop driven by surface *parameters* extracted via regex — not the surfaces' code executing, and not a real LLM coding task (Tier 2, ADR-101 / ADR-098). It is deliberately the smallest change that makes traces surface-dependent and reproducible, so the whole stack can be *validated* before spending LLM tokens or building the full agent harness.
- The scripted tasks are synthetic; they exercise retry/context/plan behaviour, not real code correctness. Real-task fidelity is Tier 2.
- The default remains `'real'`, so nothing about existing runs or the reproducibility suite changes.

## Consequences

- The night's selection work transitions from "architecturally ready, dormant" to **demonstrably live** under mock mode — with reproducible numbers, not assertions.
- The audit dashboard (ADR-099) now has a non-trivial regime to measure; the curriculum has a graded suite to ladder; Pareto has a varying capability axis to trade against parsimony.
- Tier 2 (real agent execution on real tasks) remains the production goal (ADR-101/098).

## Validation

`packages/darwin-mode` — 348 tests (was 341; +7): `extractSurfaceParams` reads the mutator-written budget/window (and defaults), `simulateAgentLoop` solves only with enough retries AND context, duration grows with retries, is deterministic; and end-to-end **two different surfaces land in different behavioural niches**. Real-mode/default paths unchanged and green. Before/after evidence committed in `bench/results/manifold-live.json`.
