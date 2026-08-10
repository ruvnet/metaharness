# ADR-107: Darwin Mode — real-LLM evaluation proof-of-concept

**Status**: Accepted (measured PoC) — bridge toward ADR-098
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-106 (Tier-2 real surface code on synthetic tasks), ADR-098 (SWE-bench targeting, deferred), ADR-087 (graded promotion / real-test oracle)

## Context

> Tier-2 (ADR-106) executes a variant's real surface *code*, but on synthetic file-location tasks. The last conceptual gap to real-world capability is a **real model fixing a real failing test, scored by the real test command**. This ADR proves that path works end-to-end — with a single, half-a-cent call — without the cost of wiring it into the full loop.

## Decision

A self-contained PoC (`bench/experiments/real-llm-eval-poc.mjs`): a merge-intervals function carrying a **real bug** (it doesn't merge touching intervals like `[1,4]+[4,5]`) plus a **real Node test** that covers exactly that case. The flow is the production evaluation path:

1. Run the real test → it **FAILS** (the bug is real, the failure is real).
2. Make **one** OpenRouter call asking for the corrected file (the failing-test output is the signal a variant's surfaces would carry: `contextBuilder` → the file, `planner` → the steps, `retryPolicy` → persistence).
3. Apply the response and **re-run the real test** — the verdict is the test command, not a heuristic.

## Result (real, 2026-06-18)

```
BEFORE: real test FAILS (touching-interval bug)
  → 1 call to google/gemini-2.5-flash (353 tokens, $0.000477, 1.4 s)
AFTER:  real test PASSES  →  verdict: FIXED
```

The production evaluation path works end-to-end for **~$0.0005**: real model + real failing test + real test command as the oracle.

## Honest scope

- **One task, one call.** This is an existence proof of the path, not a benchmark. It is deliberately **not** wired into `evolve()` — that would cost one LLM call per variant per generation (dozens to hundreds of calls per run, non-reproducible), which is exactly why the diversity/selection science was done on the reproducible Tier-1 mock (ADR-102) and Tier-2 real-code (ADR-106) substrates instead.
- The model fixed a simple, well-specified bug; real SWE-bench tasks (multi-file, under-specified) are far harder — that is the ADR-098 build, not this PoC.

## Consequences

- The full substrate ladder is now demonstrated: `real` (repo test) → `mock` (surface params, reproducible) → `agent` (real surface code, reproducible) → **real-LLM eval (real test oracle, this PoC)**.
- ADR-098 (SWE-bench) now has every piece proven independently — Tier-2 child execution + safety + trace (ADR-106), the real-test oracle and statistical gate (ADR-087), and a real model fixing a real test (this PoC). Assembling them on a real task corpus is the remaining, well-scoped build.

## Validation

PoC script + result committed (`bench/experiments/real-llm-eval-poc.mjs`, `bench/results/real-llm-eval-poc.json`). No package code changed; 349 tests unaffected.
