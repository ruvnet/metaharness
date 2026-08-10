# ADR-122: Darwin Mode — the long-horizon Validation Harness (ADR-098 step 1)

**Status**: Accepted (measured) — implements ADR-098 step 1, the "de-risk before the real benchmark" milestone
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-098 (external-benchmark strategy — step 1 = validation harness), ADR-111 (window-vs-ranking honesty), ADR-113 (ranking is causal)

## Context

> ADR-098 step 1 (the recommended starting point, before any external dataset/budget): "Build a synthetic ~50-file repository stress-test that exercises context management over 50+ sequential steps — the regime where agents *lose the thread*. Verify Darwin's loop holds state before exposing it to a real benchmark." This ships it.

## Experiment

A synthetic repo grows from 5 → 54 files over 50 sequential steps. One **old, load-bearing "core" file** (`payment_gateway_core.ts`, added at step 0) is what every step's task is really about — the "thread". At each step we ask whether the context window (W=30) still contains the core file under two policies:

- **(a) relevance-ranked** — the harness's *real* generated `buildContext` (filename↔task term-overlap ranking), capped to W;
- **(b) naive recency** — the last W files by add-order (how agents drop old context as a repo grows).

Distractors are realistic: a third share exactly one task term (`payment_history_*`, `gateway_metrics_*`) to create genuine ranking pressure (the core, sharing three, still outscores them) — so this is **not** the flat-distractor degenerate case (ADR-111). Deterministic, **0 LLM calls**. (`bench/experiments/validation-harness.mjs`.)

## Decision

### Result (deterministic, 2026-06-18)

```
50 steps, window 30, repo 5→54 files
relevance-ranked: thread retention 100%   never loses the core file
naive recency:    thread retention  52%   loses the thread at step 26 (files=31 > 30), never recovers
```

The relevance-ranked harness holds the old load-bearing file in context across the entire 50-step horizon; naive recency truncation drops it the moment the repo outgrows the window and never recovers — the canonical "lose the thread" failure.

### Significance

This is ADR-098 step 1 delivered: the harness's context management is validated to maintain architectural consistency over a long horizon *before* spending budget on a real external benchmark. It generalizes ADR-113 ("ranking is causal") from single-shot to a 50-step growing-repo regime, and isolates the exact property SWE-bench-style long-horizon tasks stress.

### Honest scope

- This isolates the **context-selection** property; it is **not** a full 50-step agentic task (no LLM edits across steps). It measures whether the right file stays *reachable*, which is the precondition for any long-horizon fix — not the fix itself.
- Per ADR-111, the result is meaningful because distractors carry **varied** term overlap (the core wins on relevance, not merely on position); against flat distractors ranking would reduce to window size.
- "Recency" is one naive baseline; a first-N baseline behaves differently. Recency is the realistic one (agents keep recent context), which is why it exhibits the loses-the-thread failure.

## Consequences

- ADR-098's roadmap advances: step 1 (validation harness) ✅ → step 2 (BenchmarkRunner adapter) → step 3 (external SWE-bench Verified corpus, user-gated on dataset + budget per the 2026-06-18 mining finding).
- The context-management arc is now validated at horizon: single-shot (113) → multi-domain (118/119) → **50-step long-horizon retention (122)**.

## Validation

Harness + result committed (`bench/experiments/validation-harness.mjs`, `bench/results/validation-harness.json`); output verified bit-identical across runs (deterministic, no network). 350 tests unaffected.
