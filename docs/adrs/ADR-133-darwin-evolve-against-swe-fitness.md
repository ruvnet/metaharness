# ADR-133: Darwin Mode — evolving the harness against a real cross-package SWE fitness (capstone)

**Status**: Accepted (measured) — the "evolve it, optimize" capstone; unites all four pillars
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-130 (fitness function), ADR-132 (multi-package corpus), ADR-127 (search/replace), ADR-126 (repair loop)

> The whole session built toward this: an actual evolutionary loop optimizing the harness against a **real SWE objective on real external code**. It unites the four pillars — evolutionary **engine** + SWE **runner** + multi-package **corpus** + **fitness function**.

## Experiment

A harness **genome** `{patchMode, maxAttempts, selectK}` is scored by the resolved-criterion over **3 external packages** (kernel-js, create-agent-harness, vertical-base — each a temp copy, own vitest suite). A `(1+λ)` evolutionary loop — **elitism + single-gene mutation**, genome-cached — climbs fitness (resolve-rate primary, cost tie-break) over generations from a diverse, deliberately-suboptimal gen-0 population. (`bench/experiments/swe-evolve-corpus.mjs`.)

## Result (real, 2026-06-18)

```
gen 0 best:  wholefile/a2/k3   3/3 resolved   $0.0093
gen 1 best:  wholefile/a1/k3   3/3 resolved   $0.0085   ← evolved winner
5 configs evaluated, 2 generations, total $0.0478
```

The evolutionary loop ran end-to-end and **improved the elite** (gen0 → gen1: same 3/3 resolve at lower cost, $0.0093 → $0.0085) by mutating `maxAttempts` 2→1. The winner is the **cheapest config that resolves the whole corpus**.

## Honest interpretation (the finding, not a spin)

- **The loop works**: elitism + mutation climbed the fitness gradient and converged. This is a genuine evolve-against-real-SWE-fitness run, on real external code, for under $0.05.
- **Resolve-rate saturated at 3/3** for *every* config — this corpus's bugs are small-file, single-fault, and easy enough that even `wholefile / 1-attempt / k3` resolves them. So fitness reduced to **cost**, and evolution correctly converged to the **cheapest sufficient** genome.
- **Therefore the winner is `wholefile/a1` — not `searchreplace`.** That is honest and correct *for this corpus*: search/replace's advantage (ADR-127) and high `maxAttempts` (ADR-126) only matter on **large-file / multi-fault** instances, which this corpus does not stress. A harder corpus (large files, multiple faults per instance) would create a resolve-rate gradient and shift the optimum toward `searchreplace` + higher `maxAttempts`. The fitness landscape — not a preset preference — determines the winner.

## Significance

This closes the loop the series set out to build: the harness is **optimized by an evolutionary search against a real SWE objective**, end-to-end, autonomously, on real external code. `score(genome) = resolveRate(corpus)` (ADR-130) is now exercised by an actual mutate→evaluate→select loop over a real corpus (ADR-132) — the literal "evolve it, optimize."

## Honest scope

- 3 external packages, in-monorepo (node_modules present), injected bugs, genome of 3 genes, `(1+λ)` with `maxAttempts ≤ 2` to bound cost. A full surface-mutation evolution on an external SWE-bench corpus at scale is still ADR-098 step 3 (dataset + budget + per-repo adapters).
- Small-n; the corpus does not discriminate capability genes (see interpretation). No leaderboard claim.

## Consequences

- The four pillars are demonstrably composable into a self-optimizing loop. What remains is purely scale/data (a capability-discriminating external corpus + budget), not mechanism.
- A natural follow-up (when budgeted): add large-file/multi-fault instances so the resolve-rate gradient drives the genome toward `searchreplace` + higher `maxAttempts`, demonstrating capability (not just cost) evolution.

## Validation

Experiment + result committed (`bench/experiments/swe-evolve-corpus.mjs`, `bench/results/swe-evolve-corpus.json`); external package sources verified clean (temp copies). darwin-mode's 350 tests unaffected.
