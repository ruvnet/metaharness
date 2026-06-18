# ADR-109: Darwin Mode — the real surface gates a real LLM on a real test (ADR-098 nucleus)

**Status**: Accepted (measured PoC) — the ADR-098 nucleus
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-106 (Tier-2 real surface code), ADR-107 (real LLM + real test), ADR-098 (SWE-bench, deferred)

> ADR-106 ran real surface code on synthetic tasks; ADR-107 had a real LLM fix a real test (but the surfaces weren't in the loop). This ADR joins them: a variant's **real contextBuilder** decides which files a **real LLM** may see, and a **real test** is the verdict. It demonstrates the core self-improvement premise — *the evolved harness determines what the agent can solve* — with all three layers real.

## Decision

A bounded PoC (`bench/experiments/real-surface-llm-eval.mjs`, run under `node --experimental-strip-types`): a real merge-intervals bug + a real Node test, hidden among 40 same-overlap distractor files. For a variant:

1. Its **real** `buildContext('fix merge intervals', files)` (executed by importing the variant's `.ts` surface) ranks + windows the files — selecting what the agent sees.
2. If the buggy file survives into that window, the **real** LLM (gemini-2.5-flash) is given it + the failing test and returns a fix; otherwise the agent never sees the bug (no call).
3. The fix is applied and the **real test command** is the verdict.

## Result (real, 2026-06-18)

| variant | real contextBuilder surfaced the bug? | real LLM → real test |
|---|---|---|
| narrow-window (10) | **no** (bug beyond the window) | not attempted → **fail** |
| wide-window (60) | **yes** | gemini-flash, 286 tok, $0.00027 → **test PASSES** |

The harness's **real surface gates whether a real LLM can fix a real bug**: narrowing the contextBuilder window hides the bug (unsolvable); widening it surfaces the bug (solved, real test green). The agent's capability is a function of the evolved surface — for **< $0.0005**.

## Significance

This is the ADR-098 **nucleus**: every layer that a real SWE-bench run needs is now joined and working — real surface code selecting context (ADR-106) + a real LLM producing a fix (ADR-107) + a real test as oracle (ADR-087) — and crucially the **surface determines the outcome**, which is the whole point of evolving the harness. A variant with a better contextBuilder literally solves bugs a worse one cannot.

## Honest scope

- One bug, one-file fix, a hand-built repo with synthetic distractors — a *nucleus*, not a benchmark. Real SWE-bench tasks are multi-file, under-specified, and need patch application across files; that is the ADR-098 build.
- Found and fixed a harness bug along the way (the test imported the module from a different path than where the fix was written — an instructive reminder that the *real test as oracle* catches integration mistakes a heuristic would miss).
- Requires Node ≥ 22; not wired into `evolve()` (per-variant LLM cost).

## Consequences

- The path from this nucleus to ADR-098 is now purely *scale + corpus*: swap the hand-built repo for a real task set, keep the exact surface→LLM→test machinery. No new mechanism is required — only engineering and tokens.
- Strengthens the provenance (ADR-108): the real-world-capability claim is no longer only architectural; the surface-gates-real-LLM property is measured.

## Validation

PoC + result committed (`bench/experiments/real-surface-llm-eval.mjs`, `bench/results/real-surface-llm-eval.json`). No package code changed; 349 tests unaffected.
