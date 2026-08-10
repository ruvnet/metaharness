# ADR-141: Darwin Mode — the full machinery reaches the global optimum on a discriminating corpus (definitive capstone)

**Status**: Accepted (measured) — removes ADR-140's caveat; the definitive close to the evolve arc
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-140 (assembly on an easy corpus), ADR-136/137 (naive-search failures), ADR-138 (noise), ADR-105 (diversity beats greedy), ADR-130/135 ((resolve, cost) objective)

## Context

> ADR-140 showed diversity+crossover+averaging *assembles* `deepseek/searchreplace`, but on an easy corpus resolve-rate saturated (4/6 at ceiling) so cost broke a wide tie — leaving the caveat "resolve-rate didn't discriminate." This re-runs on a **capability-discriminating** corpus where resolve-rate itself eliminates the bad genomes, with the **full (resolve, cost) objective**. The optimum is now reached unambiguously.

## Experiment

Capability-discriminating 2-instance corpus: (1) **two-fault** (`pareto` small + `phenotype` large) — whole-file rewrite regresses it (ADR-126), so only search/replace resolves → discriminates **patchMode**; (2) **kernel-js** — a weak model misses it (ADR-139) → discriminates **model**. Per-model MAP-Elites niches (diversity), crossover across niche elites, averaged fitness (n=3), objective = **resolve-rate then cost**. (`bench/experiments/swe-evolve-mapelites-hard.mjs`.)

## Decision

### Result (real, 2026-06-18) — `reachedGlobalOptimum: true`

```
genome                    meanResolved   meanCost   runs
deepseek/searchreplace    2/2            $0.0050    [2,2,2]   ← WINNER (cheapest at the ceiling)
gpt-5-mini/searchreplace  2/2            $0.0051    [2,2,2]
gemini/wholefile          2/2            $0.0236    [2,2,2]   (resolves, but 4.7× costlier)
gpt-5-mini/wholefile      1.67/2         $0.0166    [2,1,2]
gemini/searchreplace      1/2            $0.0067    [1,1,1]   (fails kernel-js — model)
deepseek/wholefile        1/2            $0.0102    [1,1,1]   (fails two-fault — patchMode)
```

### Findings — the complete objective, end to end

1. **Resolve-rate discriminated (the ADR-140 caveat is gone).** Unlike the easy corpus, resolve-rate itself culls the bad genomes: `gemini/searchreplace` (1/2, misses kernel-js) and every whole-file genome on the two-fault (`deepseek/wholefile` 1/2, `gpt-5-mini/wholefile` 1.67/2). Capability is now a real gradient, not a saturated ceiling.
2. **Diversity preservation kept the building block.** `deepseek/wholefile` (1/2) is a poor genome but was retained as the deepseek-niche elite — so the deepseek gene survived to recombine (it was *culled* in naive ADR-137).
3. **Crossover assembled the survivors.** `deepseek/searchreplace` (2/2) is a recombination offspring (deepseek niche × the search/replace gene).
4. **Cost broke the final, narrow tie.** Among the three genomes at the 2/2 ceiling, cost selects `deepseek/searchreplace` ($0.005) over `gpt-5-mini/searchreplace` ($0.0051) and `gemini/wholefile` ($0.0236, 4.7× — whole-file rewriting the large file is expensive). The full (resolve, cost) objective yields **one unambiguous winner**.

### Significance

This is the definitive close to the evolve arc: the engine's own machinery — **diversity-preserving selection + crossover + averaged fitness + the (resolve, cost) objective** — reaches the global optimum (`deepseek/searchreplace`) that **naive greedy (136) and naive crossover (137) both missed**, on a corpus hard enough that resolve-rate (not just cost) does the discriminating. ADR-105's "diversity beats greedy on deception" is reproduced *rigorously and unambiguously* on real SWE code, with every failure mode (local optimum, lost building block, noise, ceiling tie) addressed by a named engine mechanism (088/091, 089/093, 138, 130/135).

### Honest scope

- 2-instance corpus, n=3, genome of 2 genes, one crossover round. The two-fault is partly in-package (darwin-mode); the discrimination is real but small-scale. Full external-corpus, multi-generation averaged evolution remains ADR-098 step 3 (budget/data-gated).
- LLM results not bit-reproducible; the *ordering* (search/replace + strong model at 2/2; whole-file and gemini below) is the robust signal and matches 135/138/139/140.

## Consequences

- Evolve arc complete and rigorous: 130 → 133/134 → 135 → 136/137 (failures) → 138 (noise) → 139 (default validated) → 140 (assembly) → **141 (unambiguous global optimum on a discriminating corpus)**.
- The shipped default (`deepseek/searchreplace`, ADR-139) is re-confirmed as the evolved optimum under the full objective.

## Validation

Experiment + result committed (`bench/experiments/swe-evolve-mapelites-hard.mjs`, `bench/results/swe-evolve-mapelites-hard.json`); darwin-mode + kernel-js sources verified clean (temp copies). 350 tests unaffected.
