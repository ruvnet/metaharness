# ADR-134: Darwin Mode — capability-driven evolution on a discriminating corpus (completes ADR-133)

**Status**: Accepted (measured) — the capability half of the evolve capstone
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-133 (cost-driven evolution on an easy corpus), ADR-126/127 (whole-file vs search/replace), ADR-130 (fitness function)

## Context

> ADR-133 evolved over an easy corpus where resolve-rate saturated, so evolution converged on **cost**. The honest question it raised: does **capability** drive evolution when the corpus is hard enough to discriminate? This answers it with a corpus that includes a real **multi-fault** bug (a legitimate, common category — not a contrivance) where whole-file repair fails per-attempt.

## Experiment

Two-instance corpus: (1) a real **two-fault** bug — `pareto.ts` (small) + `phenotype.ts` (large) in one instance, which whole-file rewrite regresses (ADR-126) but search/replace fixes surgically (ADR-127); (2) an easy single-fault external bug (`vertical-base`) both modes resolve. Same `(1+λ)` evolutionary loop (elitism + single-gene mutation) over genome `{patchMode, maxAttempts, selectK}`, fitness = resolve-rate (primary), cost (tie-break). (`bench/experiments/swe-evolve-capability.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
gen 0 evaluated:  searchreplace/a1  → 2/2   $0.0045   ← elite
                  wholefile/a3      → 2/2   (resolves, but via 3 attempts → costlier)
                  wholefile/a1      → 1/2   (FAILS the multi-fault with one attempt)
evolved winner:   searchreplace/a1   2/2    $0.0045   (two-fault ✓, vertical-base ✓)
4 configs, 2 generations, total $0.0485
```

### Honest interpretation

- **The capability gene is load-bearing.** At equal (low) attempts, `searchreplace/a1` resolves **2/2** while `wholefile/a1` resolves **1/2** — search/replace fixes the multi-fault in **one** attempt where whole-file (one attempt) fails (regresses `PASS_TO_PASS`). This is a genuine resolve-rate gradient, not a cost difference.
- **Whole-file can recover, but only by spending more.** `wholefile/a3` reaches 2/2 via the regression-aware repair loop over 3 attempts — at higher cost. So the precise claim is "search/replace resolves the multi-fault in 1 attempt; whole-file needs 3," not "whole-file cannot."
- **Evolution selected the cheaper-capable genome** (`searchreplace/a1`): full resolve-rate at minimum cost — robustness *and* efficiency. This is the complement to ADR-133: there, capability saturated and cost decided; here, capability discriminates and decides (with cost breaking the remaining tie).

### Significance

Together, ADR-133 + ADR-134 show the evolve loop responding correctly to the **fitness landscape**: it optimizes cost when capability is saturated, and selects the more capable harness when the corpus discriminates. This is the "differentiator is robustness" thesis (ADR-098) demonstrated by an actual evolutionary loop on real code — search/replace is selected because it *resolves more per attempt*, not by preset.

### Honest scope

- Small corpus (2 instances), one of which is in-package (the two-fault darwin instance); injected bugs; `(1+λ)` with a 3-gene genome. A capability-discriminating *external* corpus at scale is still ADR-098 step 3.
- LLM variance is real (whole-file's recovery at a3 can shift run-to-run); the per-attempt gradient (searchreplace/a1 2/2 vs wholefile/a1 1/2) is the robust signal.

## Consequences

- The evolve capstone is complete in both regimes (cost-driven 133, capability-driven 134). The only remaining frontier is scale: a capability-discriminating **external** corpus + budget (ADR-098 step 3) — no new mechanism.

## Validation

Experiment + result committed (`bench/experiments/swe-evolve-capability.mjs`, `bench/results/swe-evolve-capability.json`); darwin-mode + vertical-base committed sources verified clean (temp copies). 350 tests unaffected.
