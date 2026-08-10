# ADR-124: Darwin Mode — the `git apply` patch primitive, and why whole-file beats raw LLM diffs (ADR-098 step-3 prep)

**Status**: Accepted (measured) — last autonomous step-3 prep; informs the step-3 patch primitive
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-123 (runner adapter, whole-file patch), ADR-098 (external-benchmark strategy)

## Context

> ADR-123 applied patches by whole-file replacement. Real SWE-bench applies a **unified diff** with `git apply` (model output is a diff). This validates a real `git apply` primitive end-to-end — and surfaces a concrete finding about which patch representation is reliable.

## Experiment

A git repo is materialized (temp copy; committed tree untouched; `node_modules` symlinked), committed, then the bug is committed as the `base_commit` state. `FAIL_TO_PASS`/`PASS_TO_PASS` are auto-derived (ADR-123). The patch primitive tries `git apply` at increasing tolerance, then a GNU `patch -p1 --fuzz=3` fallback. Two candidate diffs (`bench/experiments/swe-bench-gitapply.mjs`):

- **GOLD** — a real unified diff produced by `git diff` of the correct fix, then `git apply`-ed.
- **LLM** — the real harness loop (contextBuilder selects) asks the model for a **unified diff**; we apply it and report honestly.

## Decision

### Result (real, 2026-06-18)

```
GOLD unified diff:  git apply ✓   RESOLVED   F2P 4/4   P2P 18/18
LLM  unified diff:  apply ✗ (even with --3way and patch --fuzz=3)   UNRESOLVED
                    diffHead well-formed: "--- a/src/pareto.ts / +++ b/src/pareto.ts / @@ -1,18 +1,21 @@"
                    git apply --check: "corrupt patch at line 112"
```

The `git apply` primitive is **validated**: a correct unified diff applies and resolves the instance under the real criterion. But the raw LLM diff (gemini-2.5-flash) is **structurally headed yet corrupt mid-body** ("corrupt patch at line 112") and is not rescued by `--3way` or fuzzy `patch`.

### Finding & decision

For this model, **raw LLM unified diffs are an unreliable patch representation**; the whole-file output (ADR-123) is reliable. The recommended step-3 primitive is therefore: **model emits the whole corrected file → the harness computes the diff itself via `git diff` → `git apply`**. This yields a real, guaranteed-appliable unified-diff artifact (the SWE-bench output format) while sidestepping LLM diff-corruption. A pure-diff path remains possible but needs a diff-validate-and-repair retry loop (and likely a larger token budget) — deferred to step 3.

### Honest scope

- Single model, single instance, raw-diff prompt (`temp=0.1`, 1.5k max-tokens). The corruption may be partly format-following difficulty, not only truncation; either way the whole-file path avoids it. A more elaborate diff prompt/repair loop was not attempted (step-3 work).
- The synthetic instance is shaped like a real one; this is primitive validation, not a leaderboard number.

## Consequences

- ADR-098 roadmap: step 1 (ADR-122) ✅ → step 2 (ADR-123) ✅ → **step-3 patch primitive decided (ADR-124): whole-file → `git diff` → `git apply`.** Step 3 itself remains user-gated on a real dataset + token budget.
- The runner now has a validated diff-application primitive; the reliable end-to-end path (whole-file→diff→apply) is identified and ready to wire when a corpus arrives.

## Validation

Experiment + result committed (`bench/experiments/swe-bench-gitapply.mjs`, `bench/results/swe-bench-gitapply.json`); committed `src/pareto.ts` verified clean (temp git repo used). 350 tests unaffected.
