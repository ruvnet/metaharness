# ADR-090: Darwin Mode — wire the SGM cumulative risk budget into `evolve()`

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-076 (statistical promotion), ADR-079 (SGM risk budget + SOTA clauses), ADR-087 (graded promotion wired into evolve)

> ADR-079 defined a global, monotonic risk budget and the SOTA admission clauses (no hidden-test regression; cost-per-solve within a ceiling) so recursive self-modification cannot accumulate unbounded risk. Like the rest of the bench layer, it was never wired into the loop. ADR-087 connected the *base* statistical gate; this ADR connects the *SGM* layer on top of it.

## Context

A self-improving system that promotes a child every round can drift: each individually-justified edit is locally safe, yet the cumulative risk across dozens of rounds is unbounded. ADR-079's answer is a shared budget — every admitted promotion spends from it, and once exhausted, promotion is refused regardless of local score. It also adds two SOTA clauses on top of ADR-076: the child must not regress the hidden-test rate, and its cost-per-solve must stay within `costCeilingFactor`× the parent. `admitWithStatisticalGate` implements all of this purely; nothing called it.

## Decision

When `EvolutionConfig.benchSuite` **and** `riskBudgetTotal` are set, `evolve()`:

1. Creates **one** `RiskBudget` at the start of the run (shared across all generations).
2. Runs the per-child bench evaluation **concurrently** (no shared state), capturing the full `parentResults`/`childResults` (not just the decision).
3. Applies `admitWithStatisticalGate` **sequentially** over the results — so the shared budget charges race-free — computing `hiddenRate` and `costPerSolve` from the per-task `BenchmarkResult`s. The gate's `admit` becomes the promotion flag; its reasons plus the remaining budget are appended to `runs/<id>.bench.json`.

`riskBudgetTotal` unset → no risk cap (ADR-087 base behaviour). CLI: `evolve --bench s.json --risk-budget N`. `costCeilingFactor` defaults to 1.20.

### Why concurrent-eval then sequential-charge

The bench evaluation is the expensive part and is independent per child, so it stays under `mapLimit` concurrency. Only the budget *charge* must be serialized — a shared mutable counter cannot be charged from concurrent tasks without a race. Splitting the two keeps throughput while making the budget exact and deterministic in commit order.

## Consequences

- An `evolve --bench --risk-budget N` run promotes at most `N` self-modifications total, and only those that also hold the hidden-test rate and stay within the cost ceiling — bounded, auditable recursive self-improvement (the SGM guarantee, in the loop).
- The risk annotation in each `bench.json` makes the spend visible per child.
- Fully opt-in and layered: base statistical gate (ADR-087) → SGM clauses + budget (this) → all on top of the unchanged frozen scorer.

## Validation

`packages/darwin-mode` — 303 tests (was 302; +1 e2e): with `riskBudgetTotal: 0`, every child is refused promotion (`promoted === false`) and each `bench.json` records the SGM reasons + `risk budget remaining` annotation. Default and base-bench paths unchanged and green.
