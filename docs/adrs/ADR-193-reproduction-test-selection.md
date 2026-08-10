# ADR-193: Reproduction-test SELECTION — a conformant, Goodhart-free Test-Driven-Repair analog

**Status**: Accepted (built + conformant) · **Result: NEGATIVE-leaning** (selection ≈ judge; the +1 is noise/artifact, not the repro signal)
**Date**: 2026-06-25 *(ADR written retroactively 2026-06-27 to close the docs/adrs gap; work shipped in commit `69a58ad`)*
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-174 (self-grading trap — why candidates must NOT optimize against the repro), ADR-176 (Opus-4.8 sniper — the real lever), LEARNINGS §10 (Goodhart self-repro), §44 (this experiment), ruflo #47

## Context

> Test-Driven Repair (write a test, then patch until it passes) is a top-leaderboard pattern, but the naive form is non-conformant: if the solver optimizes its patch against its *own* model-written test, it self-grades and Goodharts (ADR-174/§10 — a weak model authors a weak repro, then games it). This ADR is the conformant analog: decouple generation from selection. Candidates never see the repro; the repro is used **only** to *select* among already-generated, independent candidates.

## Decision

Implement reproduction-test **selection** (not gating): generate N candidates **independently** of any repro (bo3 at different temperatures, `--no-test-oracle` so candidates never see gold either), then **select** the candidate that makes a separately **model-written** `reproduce_bug.py` pass. Because no candidate was optimized against the repro, there is no self-grading trap — the repro is an *independent discriminator*, not an in-loop oracle.

Components (in `packages/darwin-mode/bench/swebench/`):
- `repro-select.mjs` — the selector (generate-independent → write repro → pick the candidate that passes it; fall back to the LLM judge when no candidate passes).
- `repro-select-eval.mjs` — official `swebench` 4.1.0 gold eval (gold used for SCORING ONLY — conformant).
- `repro-select-ab.mjs` — the A/B driver.

## Result (conformant A/B, same first-25 Lite, cheap deepseek-v4-flash bo3 @ temps 0.2/0.5/0.8, official gold eval)

| selector (same 3 candidate sets) | resolve | Wilson 95% |
|---|---:|---|
| bo3 + LLM judge (baseline, `discriminator.mjs`) | 12/25 = 48% | [30.0, 66.5] |
| bo3 + repro-test select (`repro-select.mjs`) | 13/25 = 52% | [33.5, 70.0] |
| oracle union (any-of-3 candidates) | 13/25 = 52% | [33.5, 70.0] |
| Δ (repro − baseline) | **+1 instance (+4%)** | inside n=25 noise |

## The honest read — why this is NEGATIVE-leaning despite the +1

1. **The +1 is an artifact, not the repro signal.** The single gained instance (`django__django-10924`) was a `judge-fallback-norepro` case: *no* candidate passed the repro, so repro-select fell back to the plain judge. It resolved only because the two selectors **index the candidate pool differently** in the fallback path (the discriminator's env-filter reorders/dedups; repro-select keeps original set order) and happened to land on a winning candidate. It is not the repro doing the work.
2. **The repro signal rarely fires.** Diagnostics: `reproValidRate = 15/25` (a cheap model often can't author a valid failing repro at all), and of the 18 multi-candidate cases only `3/18` had the repro pass *some* candidate. The discriminating signal is too sparse to move the number.
3. **The union ceiling is the real wall.** `repro-select 52% == oracle-union 52%` — selection already extracts the full any-of-N ceiling; no selector can beat the union, and the union itself is capped at 52% on this set. The bottleneck is **candidate generation** (the cheap coder), not selection.

## Consequences

Conformant repro *selection* does not lift cheap-Pareto resolve beyond judge selection — consistent with §10/ADR-174 (a weak model's self-oracle is an unreliable target) and the broader finding that **the coder binds, not the oracle**. The real lever remains real reasoning — the Opus-4.8 sniper (ADR-176), which can both fix the hard tail *and* author a stronger repro (breaking the Goodhart loop). This result is preserved (not deleted) as a documented dead-end so it is not re-probed; the conformance discipline (candidates independent of the selection oracle) carries forward into the empty-patch cascade and later ADRs (194–198).
