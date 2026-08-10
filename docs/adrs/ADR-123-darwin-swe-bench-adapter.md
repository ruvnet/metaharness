# ADR-123: Darwin Mode — the SWE-bench BenchmarkRunner adapter + real resolved criterion (ADR-098 step 2)

**Status**: Accepted (measured) — implements ADR-098 step 2
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-098 (external-benchmark strategy — step 2 = runner adapter), ADR-120/121 (real-code loop), ADR-122 (validation harness, step 1)

## Context

> ADR-098 step 2: "Conform the harness to a standard runner contract (SWE-bench Verified task format) so results are apples-to-apples." This ships the adapter — and, crucially, the **real** SWE-bench "resolved" criterion that ADR-117…121 did not check: a patch counts only if **every `FAIL_TO_PASS` test goes red→green AND every `PASS_TO_PASS` test stays green**.

## Experiment

A `SweBenchTask`-shaped instance is synthesized from this package (`instance_id`, `problem_statement`, suites to run, the bug). The adapter:

1. Materializes the repo (temp copy; committed tree untouched; `node_modules` symlinked), introduces the bug.
2. Runs the suites via **vitest's JSON reporter** and **auto-derives** the two sets exactly as SWE-bench defines them: `FAIL_TO_PASS` = tests failing at base, `PASS_TO_PASS` = tests passing at base.
3. Applies a candidate patch, re-runs, and computes `resolved ⇔ all FAIL_TO_PASS green ∧ all PASS_TO_PASS stay green`.

Two candidate patches validate the adapter (`bench/experiments/swe-bench-adapter.mjs`):
- **Arm A — the real harness loop:** real contextBuilder selects → real LLM patches.
- **Arm B — a deterministic test-gaming patch:** type-safe, correct only for ≤2-item inputs but still buggy for >2 — designed to pass *some* target tests but not all.

## Decision

### Result (real, 2026-06-18)

```
auto-derived from base:  FAIL_TO_PASS = 4    PASS_TO_PASS = 18   (pareto+phenotype+clade)
Arm A  real LLM fix:        F2P 4/4   P2P 18/18  → RESOLVED      $0.002–0.006
Arm B  test-gaming patch:   F2P 1/4   P2P 18/18  → UNRESOLVED
```

The real harness loop produces a patch that resolves the instance under the true criterion; the test-gaming patch — which passes one target test — is correctly rejected because **all four** `FAIL_TO_PASS` must pass. The all-must-pass rule has teeth against patches that game a subset of tests.

### Significance

This is the conformance layer ADR-098 step 3 was waiting on. A real external corpus now plugs in directly: `for (const task of dataset) runSweBenchTask(task)`. And it upgrades the whole SWE arc's rigor — prior experiments checked only the target test; this enforces the real resolved criterion (no regressions in `PASS_TO_PASS`, all targets in `FAIL_TO_PASS`).

### Honest scope

- The instance is still **synthetic** (built from this package), shaped like a real SWE-bench instance; it exercises the adapter end-to-end but is not a public-leaderboard number. Step 3 supplies real instances (user-gated on dataset + budget per the ADR-098 mining finding).
- The git diff/patch application here is "replace the file content" (whole-file), not a unified-diff `git apply`; real SWE-bench uses `git apply` of `test_patch`/`patch`. The adapter's contract is unchanged — only the patch-application primitive differs and is a step-3 detail.

## Consequences

- ADR-098 roadmap: step 1 (validation harness, ADR-122) ✅ → **step 2 (runner adapter, ADR-123) ✅** → step 3 (external SWE-bench Verified corpus — user-gated: dataset + token budget + `git apply` patch primitive).
- The harness is now apples-to-apples-conformant and resolved-criterion-correct; step 3 is pure data + budget, no new mechanism.

## Validation

Adapter + result committed (`bench/experiments/swe-bench-adapter.mjs`, `bench/results/swe-bench-adapter.json`); committed `src/pareto.ts` verified clean (temp copy used). 350 tests unaffected.
