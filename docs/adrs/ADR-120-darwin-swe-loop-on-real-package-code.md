# ADR-120: Darwin Mode — the SWE loop fixes a bug in THIS package's real production code

**Status**: Accepted (measured) — closes the "toy repos" caveat of ADR-117/118
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-117 (multi-file nucleus), ADR-118 (generalization), ADR-098 (frontier)

## Context

> ADR-117/118 used hand-built toy repos. The skeptic's caveat: real code is bigger and messier. This runs the loop on **this package's own production TypeScript** — the contextBuilder selects among the 21 real `src/*.ts` files, and a real LLM fixes a real bug in real code, verified by a real test.

## Experiment

A real bug (a logic inversion — pushing *dominated* instead of *non-dominated* items) is introduced into a **copy** of the package's own `src/pareto.ts` (the committed file is never touched). The 21 real `src/*.ts` filenames are the candidate corpus. The harness's real contextBuilder selects among them; the real LLM (gemini-2.5-flash) is given the selected files' **actual source** + a failing contract test and must identify and fix the buggy file; the real test is the verdict. (`bench/experiments/swe-realcode.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
21 real candidate files     contextBuilder ranked pareto.ts #1 (relevance)
LLM chose: pareto.ts (correct, among 21)     real test: FAIL → PASS → FIXED
9,848 tokens, $0.0041     committed src/pareto.ts untouched (temp copy)
```

The loop fixed a real bug in the package's **own production code**: the real contextBuilder surfaced the right file out of 21 real source files, and the real LLM reasoned over the actual TypeScript to identify (rejecting 20 others) and correct it, confirmed by a real test.

### Significance

This is the strongest unit-level real-world result in the series: not a toy 3-file repo but **this package's actual source** (larger files, real imports, real idioms), with genuine 21-way file selection and real multi-file LLM reasoning. It directly closes the "hand-built repos" honesty caveat carried since ADR-117.

### Honest scope

- The bug is **introduced** (a realistic regression), not a naturally-occurring historical bug; it is a revert-the-regression task on real code, not a mined SWE-bench issue. One bug, one file, one call.
- ~10k tokens ($0.004) — real source is larger, so per-task cost is ~10× the toy repos; a full corpus at this rate has a real (but modest) budget.
- Still not wired into `evolve()` (per-variant cost). The remaining ADR-098 build is a *corpus* of such tasks (ideally mined from git history) + a budget — no new mechanism.

## Consequences

- The real-substrate arc now reaches the project's **own production code**: 106→107→109→110→117→118→119→**120**.
- A concrete, cheap recipe exists for the ADR-098 corpus: mine git history for commits that fixed a bug + its test, revert each into a task, run this exact loop. That is the deliberate next build.

## Validation

Harness + result committed (`bench/experiments/swe-realcode.mjs`, `bench/results/swe-realcode.json`); the committed `src/pareto.ts` is verified untouched (the experiment operates on a temp copy). 350 tests unaffected.
