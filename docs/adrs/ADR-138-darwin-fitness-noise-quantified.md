# ADR-138: Darwin Mode — the micro-evolve fitness noise floor, quantified

**Status**: Accepted (measured) — converts ADR-137's qualitative claim into a number
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-137 (noise-floor stop), ADR-136 (local optimum), ADR-112/116 (statistical-rigor / small-n honesty)

## Context

> ADR-137 *asserted* that per-cell LLM fitness variance dominates single-run micro-evolve. This **measures** it: each genome run repeatedly on the same 3-package corpus, reporting the resolve-count distribution — the rigorous basis for "average N runs" and for the ADR-137 stop.

## Method

Two genomes, each run multiple times (no cache) on the same 3-instance corpus; metric = corpus resolve count (0–3) per run. (`bench/experiments/swe-fitness-variance.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
genome                       runs (resolved/3)   mean   sd     range
deepseek/wholefile/a1        2,2,2,1,2           1.80   0.40   [1,2]
gemini/searchreplace/a2      2,2,3               2.33   0.47   [2,3]
```

### Findings

- **Per-cell fitness is genuinely noisy: sd ≈ 0.4–0.5 resolves (out of 3) for both genomes.** Neither is "stable"; at this corpus scale every cell carries ~half-a-resolve of run-to-run noise.
- **ADR-137's `deepseek/wholefile` 0/3 was a tail outlier.** Across 5 reruns its minimum was 1/3 (mean 1.8) — so that specific 0/3 was unlucky, but the *structural* claim (single runs unreliable) is confirmed and quantified. (Honest correction to the magnitude of that one data point, in the spirit of ADR-112.)
- **Genome separations are within the noise at n=1.** The two genomes' means are ~0.5 apart while sd ≈ 0.45 — their single-run distributions overlap. To distinguish genomes ~0.5 resolves apart you need the standard error below ~0.25, i.e. **n ≳ (sd/0.25)² ≈ 4–5 averaged runs per genome.** The micro-evolve (ADR-133–137) ran at **n=1** — far under this — which is exactly why greedy hill-climbing chased noise into a local optimum (ADR-136) and crossover couldn't get a clean signal (ADR-137).

### Significance

This is the quantitative foundation under the ADR-137 stop: it is not a vibe but a measured ~0.45-resolve sd that swamps the ~0.5-resolve genome differences at n=1. It also sets the **price of doing it right**: a credible SWE-genome evolution needs ≈4–5 runs per genome × population × generations — a real token-budget multiplier, which is precisely why averaged multi-run evolution belongs with ADR-098 step 3 (external corpus + budget). The series treats LLM-fitness noise with the same rigor it applied to the bootstrap/FDR gate (ADR-096/112).

## Consequences

- **Recommendation, now quantified**: for any SWE-genome evolution, average **≥5 runs per genome** (and use linkage-aware crossover, ADR-093, given the epistasis of ADR-137). Below that, results are noise-dominated.
- The micro-evolve sub-arc (130–138) is conclusively characterized: clean single-shot results (130/133/134/135) + the failure modes of naive search under noise (136/137) + the measured noise that explains them (138).

## Validation

Experiment + result committed (`bench/experiments/swe-fitness-variance.mjs`, `bench/results/swe-fitness-variance.json`); external sources verified clean (temp copies). 350 tests unaffected.
