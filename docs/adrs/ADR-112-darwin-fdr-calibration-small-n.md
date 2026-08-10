# ADR-112: Darwin Mode — FDR gate is uncalibrated at small n (self-correction of ADR-096)

**Status**: Accepted (falsification — corrects/conditions ADR-096)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-096 (BH FDR control), ADR-087 (statistical promotion), ADR-076 (bootstrap)

## Context

> The adversarial review (A2) noted ADR-096 validated BH only on idealised `Uniform(0,1)` nulls, not on the **bootstrap p-values at the small sample sizes `evolve` actually uses**. I ran the calibration check. The gate does **not** control FDR at n=3. This conditions the ADR-096 claim and is recorded as a real limitation.

## The check (deterministic, zero LLM)

Simulate the global null — parent and child task-scores drawn from the **same** distribution (no real effect) at sample size n — over 20,000 generations of 8 children each; compute each child's `bootstrapDelta` p-value, run `benjaminiHochberg(q=0.05)` across the generation, and measure the empirical false-discovery rate (all null ⇒ every rejection is false ⇒ FDR = P(any rejection)). `bench/experiments/fdr-calibration.mjs`.

## Decision

### Result (real, 2026-06-18)

| n (task-scores per variant) | p median-calibration `P(p≤0.5)` | raw `lower95>0` false-positive | **BH empirical FDR** (target ≤ 0.05) | controlled? |
|--:|--:|--:|--:|:--|
| **3** | 0.499 | 0.049 | **0.332** | **NO** |
| 5 | 0.502 | 0.0041 | 0.032 | yes |
| 10 | 0.501 | 0.0001 | 0.0001 | yes |

**At n=3, BH's empirical FDR is 33%, not 5%.** Median p-calibration looks fine, but at n=3 the bootstrap p-value is coarse and **anti-conservative in the lower tail** (with 3-vs-3 scores, the all-child-higher pattern gives a near-0 p-value too often); BH requires (super-)uniform p-values under the null, which these are not. From **n≥5** the gate controls FDR as claimed.

### Correction / condition on ADR-096

- ADR-096's "BH controls the false-discovery rate" holds **only for n ≥ 5 task-scores per variant**. ADR-096's own validation (40k uniform nulls) tested the *algorithm*, not the *bootstrap p-values at small n* — which is where it breaks.
- The default `evolve` suites in the demos use n=3 tasks, where `--fdr` would **not** deliver its advertised guarantee. The honest statement: enable `--fdr` only with a graded suite of **≥ 5 tasks**.
- The raw per-comparison gate (`lower95 > 0`) is roughly calibrated even at n=3 (0.049) — it is the BH-on-coarse-p-values step that fails at n=3.

### Fix

- A guard in `evolve()`: when `fdrQ` is set and the (curriculum-admitted) suite has fewer than 5 tasks, the gate is left to the per-comparison rule and a one-line caveat is recorded in the run, rather than silently applying an uncalibrated correction.
- Documented the n≥5 requirement in `bench/stats.ts` (`benjaminiHochberg`) and in ADR-096.

## Consequences

- The statistical-rigor story is now honest about its operating range: determinism (0) and per-comparison calibration hold; **FDR control holds at n≥5, not n=3**.
- Strengthens the provenance: a claimed guarantee was tested at the real operating point, found wanting, and conditioned — exactly the discipline the series is built on.

## Validation

Calibration harness + result committed (`bench/experiments/fdr-calibration.mjs`, `bench/results/fdr-calibration.json`). Guard + doc caveats added. 349 tests unaffected (the BH unit tests use clearly-separated p-values, which remain correct).
