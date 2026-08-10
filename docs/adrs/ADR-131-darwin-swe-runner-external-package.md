# ADR-131: Darwin Mode — the SWE runner generalizes to an external package

**Status**: Accepted (measured) — first autonomous step into the ADR-098 "external" gate
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-125–130 (the SWE runner), ADR-098 (external-benchmark frontier), ADR-120/121 (own-package code)

## Context

> ADR-120–130 validated the SWE runner on `darwin-mode` — the package it was built in. The open question for ADR-098 was whether it works on code it was *not* built around. This runs it on a **different package** in the monorepo (`kernel-js`) with its own conventions, files, and vitest suite — the first concrete, autonomous step toward external generalization.

## Experiment

A real bug is introduced into a temp **copy** of `kernel-js/src/trajectory.ts` (the rotate threshold `if (s.size <= maxBytes) return false;` → `> `, inverting `rotateIfLarger`). `runSweBenchTask` then runs the full pipeline against kernel-js's **own** vitest suite: auto-derive `FAIL_TO_PASS`/`PASS_TO_PASS`, select files, patch (search/replace), score the real resolved criterion. Committed kernel-js is never touched. (`bench/experiments/swe-external-kernel.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
external package: kernel-js (not darwin-mode)
RESOLVED   F2P 2/2   P2P 2/2   1 attempt   chose trajectory.ts   $0.0031
committed kernel-js/src/trajectory.ts verified clean (temp copy used)
```

The runner — built around `darwin-mode` — resolved a real bug in a **different** package on the first attempt, under that package's own tests, for ~$0.003. No darwin-mode-specific assumptions leaked in: file selection, search/replace patching, the vitest-JSON criterion, and the repair loop all worked on kernel-js's conventions unchanged.

### Significance

`runSweBenchTask` is genuinely **repo-agnostic**: a task is `{ instance_id, problem_statement, test_suites, materialize }`, and any package whose `materialize` lays down a failing base + a vitest suite plugs in. This is the first evidence beyond the home package, and it narrows the ADR-098 gap: the *runner* is no longer the blocker — only a real external **dataset at scale** + a **token budget** remain.

### Honest scope

- One bug, one external package, still **within this monorepo** (kernel-js's `node_modules` and vitest were already present). A true external corpus (arbitrary GitHub repos, dockerized envs, SWE-bench Verified) is more varied — different test runners, build steps, and setup that `materialize` must encode. This proves runner-agnosticism, not full SWE-bench coverage.
- Single attempt, search/replace, $0.003 — a demonstration, not a benchmark number. No leaderboard claim.

## Consequences

- ADR-098 is de-risked one step further: the runner generalizes across packages. The remaining frontier is purely **dataset + budget + per-runner `materialize` adapters** — no new core mechanism.
- A multi-package self-hosted corpus (several monorepo packages, each with a known bug) is now a cheap, autonomous option for a small resolve-rate number, should that be wanted.

## Validation

Experiment + result committed (`bench/experiments/swe-external-kernel.mjs`, `bench/results/swe-external-kernel.json`); committed `kernel-js/src/trajectory.ts` verified clean (temp copy). darwin-mode's 350 tests unaffected.
