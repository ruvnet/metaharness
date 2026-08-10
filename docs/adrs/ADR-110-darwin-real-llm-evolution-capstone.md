# ADR-110: Darwin Mode — evolution improves a real LLM's real-test pass-rate (capstone)

**Status**: Accepted (measured) — the capstone
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-109 (surface gates real LLM), ADR-106 (Tier-2), ADR-103 (self-improvement on mock), ADR-098 (SWE-bench, deferred)

## Context

> ADR-109 showed a *static* contrast: a wide-window variant lets a real LLM fix a real test that a narrow one cannot. This ADR closes the loop **dynamically**: a real evolutionary search, scored end-to-end by the real surface→real-LLM→real-test pipeline, *discovers* the better harness and lifts a real LLM's real-test pass-rate. It is the full self-improvement premise on the fully-real substrate.

## Decision

A mini evolution loop (`bench/experiments/real-llm-evolution.mjs`, run under `node --experimental-strip-types`): the **real `DeterministicMutator`** mutates variants (6 generations × 5 children); each variant is scored by the **real** pipeline — its real `contextBuilder` selects files, and for each of 3 tasks (buggy file at rank ~8/38/65) where the bug is surfaced, a **real LLM** fix is applied and the **real test command** is the verdict. Solving more tasks requires a wider context window. The LLM fix for the (constant) bug is **cached**, so the whole run costs **one** real call.

## Result (real, 2026-06-18)

```
gen0: 1/3   gen3: 2/3   gen5: 3/3        (contextBuilder window evolved 30 → 70)
llmCalls: 1 (cached)  ≈ $0.0003
```

The evolutionary loop — judged by a real LLM passing real tests — **discovered the wider contextBuilder window and climbed the pass-rate from 1/3 to 3/3.** Real mutator + real surface code + real LLM + real test, self-improving, for ~$0.0003.

## Significance

This is the ADR-098 behaviour, demonstrated end-to-end at micro scale: *evolving the harness measurably improves what a real model can solve, verified by real tests.* Combined with the earlier results it completes the chain —

- the manifold is live (102), the loop self-improves (103), diversity beats greedy on deception (105) — on the reproducible mock substrate;
- real surface code drives outcomes (106), a real LLM fixes a real test (107), the surface gates the LLM (109) — on the real substrate;
- and now **evolution lifts a real LLM's real-test pass-rate** (110).

## Honest scope

- One bug type, **one** tunable surface (the contextBuilder window), hand-built tasks, the fix cached. It proves the *mechanism* end-to-end, not real-world coding competence.
- A real SWE-bench run needs multi-file, under-specified tasks and a real per-variant LLM fix (no caching), which is token-costly and is the remaining ADR-098 build — engineering and budget, no new mechanism.
- LLM step is non-reproducible; the reproducible science stays on the mock/agent substrates.

## Consequences

- The provenance (ADR-108) now includes the strongest possible short-of-SWE-bench result: real evolution improving real-LLM real-test success.
- ADR-098 is de-risked to a scale/corpus problem; every mechanism it needs is proven and committed.

## Validation

Capstone experiment + result committed (`bench/experiments/real-llm-evolution.mjs`, `bench/results/real-llm-evolution.json`). No package code changed; 349 tests unaffected.

---

## Correction (ADR-111)

A falsification (ADR-111) showed this is a **1-D, monotonic, noise-free window-size sweep**: a hill-climber or random restart finds `window >= 66` trivially, and a no-ranking first-N selector matches the real contextBuilder at every window. Honest restatement: this proves the **surface->real-LLM->real-test pipeline is wired end-to-end and an evolvable surface parameter causally gates real-LLM capability** — it is **not** a demonstration of non-trivial evolutionary search on the real substrate (that is shown only on the mock substrate, ADR-105). See ADR-111.
