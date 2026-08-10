# ADR-136: Darwin Mode — full-genome evolution hits a local optimum (why diversity/crossover exist)

**Status**: Accepted (measured) — an honest negative result that re-motivates the engine's machinery
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-135 (SWE-fix model frontier), ADR-133/134 (evolve loops), ADR-105 (diversity beats greedy on deception), ADR-088–094 (diversity/crossover machinery)

## Context

> ADR-135 found `deepseek/searchreplace` is the cheapest full-resolve config by a *manual* frontier sweep. This asked the obvious follow-up: can the `(1+λ)` evolve loop **discover** it autonomously by mutating a `model` gene alongside `{patchMode, maxAttempts}`? The honest answer is **no — naive single-gene hill-climbing gets trapped at a local optimum.** That is the interesting result.

## Experiment

Genome `{model ∈ [gemini-flash, deepseek-chat, gpt-5-mini], patchMode, maxAttempts}`, fitness = cross-package resolve-rate (cost tie-break) over 3 external packages, optimized by a `(1+λ)` loop (elitism + single-gene mutation, genome-cached), seeded on the suboptimal default model. (`bench/experiments/swe-evolve-fullgenome.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
gen 0: elite gemini-flash/wholefile/a1   3/3  $0.0142   (hit max resolve-rate immediately — partly gen-0 variance)
gen 1: neighbours gemini/searchreplace/a1 → 2/3, deepseek/wholefile/a1 → 2/3   (both worse → rejected)
gen 2: neighbour gemini/wholefile/a2 → 3/3 but costlier → elite unchanged
WINNER: gemini-flash/wholefile/a1   3/3   $0.0142
```

The loop converged to `gemini-flash/wholefile/a1` and **never evaluated `deepseek/searchreplace`** — ADR-135's cheaper global optimum (3/3 at **$0.006**, vs this winner's **$0.014**).

### Why (the finding)

- **Local optimum across a noisy-fitness valley.** From the gen-0 elite, the global optimum is **two** simultaneous gene changes away (`model→deepseek` *and* `patch→searchreplace`). Each single-gene step lands on a `2/3` neighbour (`deepseek/wholefile` and `gemini/searchreplace` both scored 2/3 — partly genuine, partly LLM variance), so elitism on resolve-rate **rejects the intermediate steps** and the hill-climb cannot cross the valley.
- **Gen-0 variance seeded the trap.** `gemini/wholefile/a1` resolving 3/3 here is itself variance (ADR-135's `gemini/searchreplace/a2` missed kernel-js); hitting max resolve-rate early left no resolve-rate gradient for the hill-climb to follow, so cost alone couldn't pull it across two genes.

### Significance — this is *why* Darwin has diversity + crossover

This is a textbook local-optimum failure of greedy/single-step search on a **deceptive** landscape — exactly the regime ADR-105 built for, where greedy crossed an epistatic plateau **0/5** but behavioral-diversity **5/5**. The SWE full-genome landscape is deceptive in the same way (the optimum needs a coordinated two-gene move). So the engine's **diversity-preserving selection** (ADR-091/092) and **crossover** (ADR-089/093) — which recombine genes from different lineages and maintain exploration — are the antidote to precisely this trap; a `(1+λ)` hill-climb is the wrong optimizer for this genome. The honest negative result empirically re-justifies the machinery the series already built.

### Honest scope

- One run; LLM fitness is noisy (the 2/3 intermediates could be 3/3 on another run, which would change the path). The robust point is structural: single-gene elitist hill-climbing cannot reliably cross a two-gene valley under noise.
- A natural follow-up (when budgeted): run the SAME genome with the engine's **crossover + behavioral-diversity** selection and show it reaches `deepseek/searchreplace` where the hill-climb stalls — the direct analogue of ADR-105 on the SWE substrate.

## Consequences

- Recommended optimizer for the full SWE genome: the engine's diversity/crossover selection, **not** naive hill-climbing. ADR-135's `deepseek/searchreplace` remains the known optimum (use it as the default).
- Connects the SWE arc back to the engine's core thesis: diversity beats greedy on deception (ADR-105) — now observed on the real SWE config landscape, not just the mock substrate.

## Validation

Experiment + result committed (`bench/experiments/swe-evolve-fullgenome.mjs`, `bench/results/swe-evolve-fullgenome.json`); external sources verified clean (temp copies). 350 tests unaffected.
