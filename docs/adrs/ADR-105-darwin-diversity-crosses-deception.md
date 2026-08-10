# ADR-105: Darwin Mode — diversity selection crosses a deception greedy cannot (the justification)

**Status**: Accepted (measured — multi-seed)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-088 (MAP-Elites), ADR-091 (hyperbolic phenotype), ADR-094 (clade), ADR-089 (crossover), ADR-102/103/104 (live manifold + self-improvement + mutation fix)

## Context

> The diversity/phenotype machinery (ADR-088/091/092/094) has been correct, tested, and — since ADR-102 — live. But one question decided whether it was *worth* it: does it actually solve problems greedy score-selection cannot? This experiment answers it with a clean, multi-seed contrast. It does.

## Experiment

A deliberately **deceptive epistatic landscape** (mock mode, `mockTasks`): three easy tasks every variant solves, plus one "treasure" that requires **both** `maxAttempts > 3` **and** `contextWindow ≥ 45` — two surfaces improved at once. Because the easy tasks are already solved, improving *either* surface alone yields **no score gain**: greedy promotion sees a flat plateau. Only by retaining the complementary stepping-stones (a high-retry variant and a high-context variant, in different niches) and **recombining** them via crossover can a variant reach the treasure.

Run: `evolve()` mock mode, 20 generations × 8 children, crossover + epistasis, **5 seeds** (7, 11, 23, 42, 101), three selection strategies. Measured: how often each crosses the treasure. (`bench/experiments/deception.mjs`, `bench/results/deception-experiment.json`.)

## Decision

### Result (real, 2026-06-18)

| selection | crossed the deception | max finalScore |
|---|---|---|
| `score` (greedy) | **0 / 5** | 0.8475 (plateau) |
| `behavioral-diversity` | **5 / 5** | 0.985 |
| `clade` | **4 / 5** | 0.985 |

**Greedy never crosses it (0/5). Behavioral-diversity always does (5/5); clade nearly always (4/5).** The advanced selection retains niche-diverse stepping-stones that crossover recombines across the plateau — exactly the mechanism MAP-Elites/QD predicts. This is the empirical justification the stack lacked.

### Honest reading

- **`behavioral-diversity` is the clear winner here (5/5).** `clade` is strong but not perfect (4/5) — on seed 7 it stayed on the plateau. So the result justifies *diversity-based* selection most directly; clade's deception-crossing is good but seed-sensitive at these settings.
- It is a **mock**, deterministic landscape (ADR-102 Tier 1), not a real coding task — an existence proof that the mechanism works, not a claim about real-world SWE tasks (Tier 2, ADR-101/098).
- The contrast depends on the deception being *reachable* (thresholds within the mutator's explored range, which ADR-104 widened) — a stronger deception (`maxAttempts ≥ 6 AND window ≥ 60`) was crossed by *none* of them, an honest upper bound on current capability.

## Consequences

- The diversity/phenotype/clade machinery (ADR-088/091/092/094) is now **empirically justified**, not just architecturally present: it provably solves an epistatic problem greedy selection cannot (0/5 → 5/5).
- Recommends `behavioral-diversity` (or `clade`) over plain `score` selection whenever the task landscape may be deceptive/epistatic — which real multi-file refactoring is.
- Open follow-ups: why clade trails behavioral-diversity here (4/5 vs 5/5); multi-seed CI; and the same contrast under Tier-2 real-agent execution.

## Validation

348 tests unchanged (this is an experiment over the existing engine; `EvolutionConfig.mockTasks` added to supply the landscape). Multi-seed result committed in `bench/results/deception-experiment.json`; harness in `bench/experiments/deception.mjs`.

## Follow-up: why does clade trail behavioral-diversity? (investigation + negative result)

Instrumented seed 7 (where clade stayed stuck): clade explored **21** distinct `(retry, window)` pairs and reached `retry 5, window 50`, yet produced **0** variants combining *both* improvements — whereas behavioral-diversity produced **123**. So clade *explores* fine but rarely **pairs complementary stepping-stones** for crossover: on the plateau every clade has ~0 successes, so its Thompson sampling does not specifically select a high-retry parent *and* a high-window parent as the two breeders.

A fix was tried: rank a wider clade-Thompson pool, then pick the two parents from **distinct behavioural niches** (`pickDiverseByNiche`). Measured across the same 5 seeds it was **net-neutral — still 4/5**, merely shifting which seed fails (7 now crosses, 23 now doesn't). Root cause of the wash: the behavioural niche (trace-derived: fail/timeout/verbosity/duration) does **not** separate the *genotypic* stepping-stones (a high-retry and a high-window variant often share a niche because they solve the same easy tasks), so "distinct niche" can't reliably pick complementary breeders. **The change was reverted** (no measured payoff; keep clade simple).

Honest conclusion: closing clade's gap would need a *genotypic*/parameter-aware diversity signal for parent pairing, not the trace-based behavioural niche. Until then, **`behavioral-diversity` remains the recommended selection for deceptive/epistatic landscapes** (5/5 vs clade 4/5). Negative results recorded rather than hidden.
