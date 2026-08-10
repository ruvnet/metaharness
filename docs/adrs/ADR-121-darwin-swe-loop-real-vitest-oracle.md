# ADR-121: Darwin Mode — the SWE loop verified by the package's OWN committed vitest suite

**Status**: Accepted (measured) — most authentic real-code oracle in the series
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-120 (real package code, hand-written contract test), ADR-098 (frontier)

## Context

> ADR-120 fixed a bug in the package's real `pareto.ts`, but the verdict was a *hand-written* contract assert. The skeptic's remaining gap: "your oracle isn't the real test suite." This closes it — the verdict is the package's **own committed `pareto.test.ts`, run under vitest**.

## Experiment

A full copy of the package is made in a temp dir (committed tree untouched; `node_modules` **symlinked** so no reinstall). The proven logic-inversion bug (push *dominated* instead of non-dominated) is introduced into the copy's `src/pareto.ts`. The package's real `npx vitest run pareto` is the oracle. The harness's real contextBuilder selects among the 21 real `src/*.ts`; a real LLM fixes the real TypeScript; vitest is re-run as the verdict. (`bench/experiments/swe-realtests.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
oracle: package's own pareto.test.ts (vitest)     21 real candidate files
contextBuilder ranked pareto.ts #1     LLM chose pareto.ts (correct, among 21)
vitest: FAIL → PASS → FIXED     9,782 tokens, $0.0041     committed tree untouched
```

The package's **own committed test suite** went red→green: the real contextBuilder surfaced the right file out of 21, the real LLM fixed the real TypeScript, and the project's actual vitest oracle confirms it.

### Significance

This is the most authentic unit-level real-code result the series can show without a mined historical corpus: real source, real 21-way selection, real LLM reasoning, and the **project's own test command** as the judge — no bespoke oracle. It closes the last "your test isn't real" caveat behind ADR-120.

### Honest scope

- The bug is still **introduced** (revert-a-regression), not a mined historical issue; one bug, one file, one call. Authenticity gained here is the *oracle* (real vitest suite), not the bug's provenance.
- Same ~$0.004 / ~10k tokens as ADR-120. No new mechanism — it swaps the hand-written assert for `vitest run`.
- The only remaining rung is genuinely-historical bugs at corpus scale (ADR-098): mine git history for bug-fix+test commits, revert each, run this exact loop with `vitest` as oracle.

## Consequences

- Real-substrate arc: 106→107→109→110→117→118→119→120→**121** (real code **and** real test suite).
- ADR-098 is now fully de-risked end-to-end: every link (real selection, real fix, real vitest oracle, real code) is individually proven; only corpus + budget remain.

## Validation

Harness + result committed (`bench/experiments/swe-realtests.mjs`, `bench/results/swe-realtests.json`); committed `src/pareto.ts` verified clean (experiment uses a temp copy with symlinked node_modules). 350 tests unaffected.
