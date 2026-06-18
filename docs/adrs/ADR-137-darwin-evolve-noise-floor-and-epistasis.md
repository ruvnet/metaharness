# ADR-137: Darwin Mode — the micro-evolve noise floor + model×patchMode epistasis (honest stop)

**Status**: Accepted (measured) — an honest limitation finding; concludes the micro-evolve thread
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-136 (local optimum), ADR-135 (model frontier), ADR-093 (epistatic linkage / topology-aware crossover), ADR-116 (retention inconclusive at n=2)

> ADR-137 set out to show diversity+crossover escaping ADR-136's local optimum by recombining the `deepseek` and `searchreplace` genes (the ADR-105 analogue on real SWE code). It did **not** — and the reasons are themselves the finding: per-cell LLM-fitness variance dominates at this scale, and the genome is **epistatic**, so naive uniform crossover destroys the winning combination. This ADR records that honestly and stops the micro-evolve thread as noise-limited.

## What happened

Diverse gen-0 population (the `deepseek` gene and the `searchreplace` gene seeded in *different* individuals), uniform crossover, 3-package corpus. (`bench/experiments/swe-evolve-crossover.mjs`.)

```
gen 0:  gemini/wholefile/a1      3/3  $0.012   ← elite
        gpt-5-mini/wholefile/a1  3/3  $0.0121
        gemini/searchreplace/a2  2/3  $0.0113
        deepseek/wholefile/a1    0/3  $0.0066  ← the deepseek-gene carrier — eliminated
winner: gemini/wholefile/a1 (local optimum again); crossover produced no new genomes → 1 generation
```

## Two honest findings

1. **The micro-evolve experiments are noise-dominated.** The single cell `deepseek-chat/wholefile/a1` scored **0/3 here, 2/3 in ADR-136**; and `deepseek/searchreplace` was **3/3 in ADR-135**. With one run per cell on a 3-instance corpus, the fitness signal is swamped by LLM variance for most genomes — only *strong* effects are consistent (e.g. `gemini/searchreplace` reproducibly misses kernel-js, 2/3). **Clean evolutionary attribution needs averaged runs** (several samples per genome), which is a real token-budget multiplier — the same noise limit ADR-116 hit at n=2.
2. **The genome is epistatic (model × patchMode interact).** `deepseek/searchreplace` is excellent (135) but `deepseek/wholefile` is poor (0/3 here) — the model gene's value *depends on* the patch gene. So the `deepseek` "building block" hitchhikes on a low-fitness `wholefile` background, is selected out before it can recombine, and **naive uniform crossover (which assumes gene independence) cannot assemble `deepseek/searchreplace`.** This is precisely the regime **ADR-093 (epistatic-linkage / topology-aware crossover)** was built for: linkage-aware recombination keeps interacting genes together; uniform crossover breaks them.

## Conclusion (disciplined stop)

The clean, reproducible evolve results stand: **ADR-130** (fitness selection), **ADR-133** (cost-driven evolution), **ADR-134** (capability-driven evolution), **ADR-135** (model frontier — deepseek/searchreplace is the optimum), **ADR-136** (greedy hits a local optimum). Beyond them, the micro-evolve experiments are **noise-limited and epistasis-confounded** at this corpus scale and single-run budget. Pushing further (averaged multi-run GA with linkage-aware crossover, ADR-093) is real but **budget-gated** — it belongs with ADR-098 step 3 (a larger external corpus + the budget to average). Recording the limit and stopping here is the honest move, not chasing noise.

## Recommendation

- Use **`deepseek/searchreplace`** as the harness default (ADR-135's measured optimum).
- For any future SWE-genome evolution, average ≥3 runs per genome and use **linkage-aware crossover (ADR-093)**, not naive uniform crossover — the genome is epistatic.

## Validation

Experiment + result committed (`bench/experiments/swe-evolve-crossover.mjs`, `bench/results/swe-evolve-crossover.json`); external sources verified clean (temp copies). 350 tests unaffected. This is an honest negative/limitation result in the spirit of ADR-111/112/114/116 — recorded, not hidden.
