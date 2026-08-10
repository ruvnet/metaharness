# ADR-139: Darwin Mode — the deepseek default, validated under averaging (and it's also the most stable)

**Status**: Accepted (measured) — averaged validation of the ADR-135 default change
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-135 (model frontier, n=1), ADR-138 (noise floor quantified), the default-model commit (2bd4cee)

## Context

> ADR-135 chose deepseek-chat as the SWE-fix default from a *single* run, and that default was shipped (commit 2bd4cee). ADR-138 then showed single runs are noisy. The responsible follow-up — applying the noise-floor lesson to the decision itself — is to validate the change with averaged runs before relying on it. This does that.

## Method

The new default (`deepseek/searchreplace`) and the old default (`gemini/searchreplace`) are each run **N=4** times on the same 3-package corpus (same config: search/replace, maxAttempts=2, k=6). (`bench/experiments/swe-default-validation.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
genome                              runs        mean   sd     cost
deepseek/searchreplace (NEW)        3,3,3,3     3.00   0.00   $0.01
gemini/searchreplace   (OLD)        2,3,2,2     2.25   0.43   $0.01
```

### Findings

- **The default change is validated** — and more strongly than ADR-135's single run implied. `deepseek/searchreplace` resolves **all 3 instances on every one of 4 runs (mean 3.0, sd 0)**, strictly better than `gemini/searchreplace` (mean 2.25) at equal cost. This is not an n=1 fluke.
- **The optimum is also the most stable.** deepseek/searchreplace has **sd=0** here — perfectly reliable — whereas ADR-138 measured sd≈0.40 for deepseek/**wholefile**. So the ADR-138 noise was specific to the *bad* epistatic combo (deepseek+wholefile); the *good* combo (deepseek+searchreplace) is rock-solid. Capability and reliability coincide at the optimum.
- This also re-confirms the consistent signal across 135/138/139: `gemini/searchreplace` unreliably misses kernel-js (2–3/3), the lone genome whose difficulty exposes model capability.

### Significance

A responsible close to the model-axis work: the default was shipped from a single observation, then **validated under averaging** (the exact discipline ADR-138 prescribed) before being relied upon — and the averaged evidence strengthened it. The series applies its own noise-floor lesson to its own decisions.

### Honest scope

- N=4, 3-instance corpus, in-monorepo. The deepseek sd=0 is over 4 runs on these 3 bugs — strong but not infinite n; a larger corpus could surface harder cases where deepseek also varies. The comparison (deepseek ≥ gemini on resolve and cost) is the robust claim.

## Consequences

- The `deepseek/deepseek-chat` default (commit 2bd4cee) stands — validated, not just measured-once.
- The model-axis sub-thread (135 → 138 → 139) is complete: frontier → noise → averaged validation. Larger-scale averaged evolution remains ADR-098 step 3.

## Validation

Experiment + result committed (`bench/experiments/swe-default-validation.mjs`, `bench/results/swe-default-validation.json`); external sources verified clean (temp copies). 350 tests unaffected.
