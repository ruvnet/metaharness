# ADR-125: Darwin Mode — the consolidated `runSweBenchTask()` corpus-ready runner

**Status**: Accepted (measured) — the single entry point an external corpus iterates
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-123 (resolved criterion), ADR-124 (whole-file patch primitive decision), ADR-098 (strategy)

## Context

> ADR-122/123/124 proved the pieces separately (validation harness, resolved criterion, patch primitive). This consolidates them into ONE function — `runSweBenchTask(task, opts)` — so step 3 is literally `for (const task of dataset) await runSweBenchTask(task, { model, key })`.

## Decision

### What it does

`bench/swe-bench-runner.mjs` exports `runSweBenchTask(task)`. A `task` carries `{ instance_id, problem_statement, test_suites, materialize(workDir) }` (a real corpus task's `materialize` would `git checkout base_commit` + apply `test_patch`). The runner:

1. **Materialize** the repo at the failing base state; `git init` + commit.
2. **Auto-derive** `FAIL_TO_PASS` (failing now) / `PASS_TO_PASS` (passing now) via vitest's JSON reporter (ADR-123).
3. **Select** files with the harness's *real* contextBuilder (gated).
4. **Patch** — the model emits a **whole corrected file** (ADR-124: reliable; raw LLM diffs corrupt); the runner writes it and captures the real unified-diff artifact via `git diff` for provenance.
5. **Score** the real resolved criterion (`all F2P green ∧ all P2P stay green`).

Returns `{ instance_id, resolved, f2p, p2p, chose, patchBytes, tokens, cost_usd }`.

### Result (real, 2026-06-18)

```
runSweBenchTask(synthetic__pareto-dominance):
  resolved: true   f2p 4/4   p2p 18/18   chose pareto.ts   patchBytes 3852   $0.006
```

The full reliable pipeline runs end-to-end in a single call and resolves the instance under the true criterion, emitting a real unified-diff artifact.

### Significance

This is the deliverable ADR-098 step 3 plugs into: a measured, corpus-ready runner with the resolved criterion and the decided reliable patch primitive baked in. No orchestration remains to invent — only a real dataset + token budget.

### Honest scope

- The validated instance is **synthetic** (built from this package), shaped like a real one; this validates the *runner*, not a leaderboard score.
- `materialize` for a real corpus must implement `git checkout base_commit` + `git apply test_patch`; the synthetic one copies the package + introduces the bug. The runner contract is identical.
- Single model / single instance; the runner has no retry/repair loop yet (a step-3 robustness add for harder instances).

## Consequences

- ADR-098 is now end-to-end ready: step 1 (122) ✅, step 2 (123) ✅, patch primitive (124) ✅, **consolidated runner (125) ✅**. Step 3 = supply `dataset` + budget and iterate `runSweBenchTask`.
- The SWE arc concludes at a reusable API rather than a pile of one-off experiments.

## Validation

Runner + validation + result committed (`bench/swe-bench-runner.mjs`, `bench/experiments/swe-bench-run.mjs`, `bench/results/swe-bench-run.json`); committed `src/pareto.ts` verified clean (temp git repo used). 350 tests unaffected.
