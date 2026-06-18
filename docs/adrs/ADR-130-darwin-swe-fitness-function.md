# ADR-130: Darwin Mode — `runSweBenchTask` as a fitness function for harness selection

**Status**: Accepted (measured) — closes the loop between the SWE runner and the evolutionary engine
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-125–129 (the SWE runner), ADR-072/087 (efficiency tie-break above the capability ceiling), ADR-098 (external-benchmark strategy)

> The whole SWE runner (ADR-123–129) exists so the harness can be *scored on real tasks*. This closes the loop: a config population is evaluated by the real resolved-criterion over a small corpus, and the SWE resolve-rate (tie-break: cost) **selects** the best harness configuration — the exact signal `evolve()` would optimize.

## Experiment

A 2-instance corpus — one **small** file bug (`pareto.ts`) and one **large** file bug (`phenotype.ts`) — is the fitness set. A config population (the genotype = patch primitive × repair budget) is evaluated by running both instances through `runSweBenchTask` with each config; fitness = resolve count (primary), cost (tie-break). (`bench/experiments/swe-fitness-selection.mjs`.)

## Result (real, 2026-06-18)

```
config             resolveRate   cost
wholefile/1        2/2           $0.0118
wholefile/3        2/2           $0.0103
searchreplace/3    2/2           $0.0076   ← fitness-selected (cheapest at equal resolve-rate)
```

The SWE resolved-criterion ranks every config and selects `searchreplace/3` — it matches whole-file on capability (all resolve 2/2 this run) at **~35% lower cost**. Stable winner across runs.

## Significance

This is the bridge from the runner to the evolutionary engine: `runSweBenchTask` is a *fitness function* over harness configurations. It is the literal signal `evolve()` would maximize when mutating surfaces — here exercised as a single-generation selection over a config population. It also instantiates the **efficiency tie-break** (ADR-072/087): above the capability ceiling (all configs resolve), fitness selects the cheaper harness — now driven by the real SWE objective rather than a synthetic score.

## Honest scope

- **Single-generation, config-space** selection — not multi-generational *surface* evolution. The latter (mutating the 7 surfaces and scoring each variant on a real corpus) is ADR-098 step 3, budget-gated by per-variant LLM cost.
- Resolve-rate **tied** this run: whole-file happened to rewrite the large `phenotype.ts` without regression (model variance; ADR-126 showed it *can* regress 6+ `PASS_TO_PASS`). So the discriminator here was **cost**; `searchreplace` is additionally **lower-risk** on large files per ADR-126. The fitness function would surface that risk as a resolve-rate gap on runs where the regression occurs.
- 2-instance corpus is a demonstration scale, not a benchmark number.

## Consequences

- The SWE runner is now usable as `evolve()`'s scorer: `score(variant) = resolveRate(corpus)` with a cost tie-break. Wiring it into the multi-generational loop is mechanical; the cost is the only gate (ADR-098 step 3).
- The arc is complete end-to-end: build the loop (120–125) → harden it (126–129) → **use it as a fitness function (130)**.

## Validation

Experiment + result committed (`bench/experiments/swe-fitness-selection.mjs`, `bench/results/swe-fitness-selection.json`). LLM results are not bit-reproducible; the winner ordering was stable across runs. Core `src` unchanged — 350 tests unaffected.
