# ADR-119: Darwin Mode — evolution lifts real-LLM real-test pass-rate across a multi-domain suite

**Status**: Accepted (measured) — multi-domain dynamic capstone
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-110 (single-task evolution capstone), ADR-117/118 (real multi-file nucleus + generalization), ADR-111 (window-vs-ranking honesty)

> ADR-110 evolved one harness parameter to lift a single real-LLM task; ADR-118 showed the real loop generalizes statically across five domains. This ties them: a real evolutionary loop that lifts the real-LLM real-test pass-rate across all five domains at once.

## Experiment

Five real bugs (intervals/slugify/gcd/chunk/query), each **buried** behind 35 same-term distractor files so the baseline contextBuilder window (30) misses the buggy file → baseline fails. A real evolutionary loop (real `DeterministicMutator`, 6 gens × 5 children) evolves the harness; each variant is scored by the **real** pipeline over all five tasks: its contextBuilder selects files → if the buried buggy file is surfaced, a **real LLM fix** (cached per bug → 5 calls total) is applied → the **real test** is the verdict. (`bench/experiments/swe-evolution.mjs`.)

## Result (real, 2026-06-18)

```
gen0: 0/5   gen1: 0/5   gen2: 0/5   gen3: 5/5  (stable)
contextBuilder window evolved 30 → 50      llmCalls: 5 (cached)   ≈ $0.002
```

The baseline solves **none** (every buggy file buried beyond its window); evolution widens the contextBuilder window (30→50), surfaces all five buried files, the cached real LLM fixes apply, and **all five real tests pass — 0/5 → 5/5 by generation 3.** Evolution lifted the real-LLM real-test pass-rate across five domains by evolving the harness, for ~$0.002.

## Significance

This is the strongest dynamic real-substrate result the series can show without a real corpus: the harness self-improves, measured by real LLM fixes verified by real tests, across multiple real bug domains at once. It is the multi-domain union of ADR-110 (evolution lifts pass-rate) and ADR-118 (works across domains).

## Honest scope

- Per ADR-111, this is **window** evolution: the buried files are surfaced by *widening* the contextBuilder window (the distractors are same-term, so ranking ≡ input order here). It is the evolvable surface *parameter* lifting capability, not ranking-intelligence evolution.
- The LLM fixes are real but **cached per bug** (constant per task), so this measures harness evolution, not per-variant LLM variance. 5 calls total.
- Hand-built repos, clear bugs — a demonstration of the *mechanism* at suite scale, not a SWE-bench number. The real corpus + per-variant uncached fixes is the remaining ADR-098 build.

## Consequences

- The real-substrate arc is complete at the unit/suite level: real surface code (106) → real LLM fix (107) → surface gates LLM (109) → single-task evolution (110) → multi-file reasoning (117) → multi-domain generalization (118) → **multi-domain evolution lifting pass-rate (119)**.
- ADR-098 is now purely scale + a real corpus + a budget; every mechanism is proven and committed.

## Validation

Harness + result committed (`bench/experiments/swe-evolution.mjs`, `bench/results/swe-evolution.json`). 5 cached LLM calls. 350 tests unaffected.
