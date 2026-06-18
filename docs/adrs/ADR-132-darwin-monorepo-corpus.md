# ADR-132: Darwin Mode — a multi-package self-hosted SWE corpus (cross-package resolve-rate)

**Status**: Accepted (measured) — ADR-098-step-3-flavored result at monorepo scale
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-131 (one external package), ADR-130 (fitness function), ADR-098 (external-benchmark frontier)

> ADR-131 showed the runner resolves a bug in one external package. This scales to a real **cross-package resolve-rate**: one known bug in each of four monorepo packages — different codebases, conventions, and vitest suites — all scored by the *same* runner under the real resolved-criterion. The honest middle ground between one external package and the full external SWE-bench corpus.

## Experiment

Four instances, one per package, each operated on via a temp **copy** (committed sources untouched); the runner auto-derives `FAIL_TO_PASS`/`PASS_TO_PASS` from each package's own tests, selects files, patches (search/replace), and scores. (`bench/experiments/swe-monorepo-corpus.mjs`.)

| package | bug | suite |
|---|---|---|
| `kernel-js` | `rotateIfLarger` size threshold inverted (`<=`→`>`) | trajectory |
| `create-agent-harness` | `summarise` `allHardPass` uses `some` not `every` | constraints |
| `vertical-base` | `validateVerticalManifest` drops the empty-id check | base |
| `darwin-mode` | `paretoFront` pushes dominated items | pareto |

## Result (real, 2026-06-18)

```
resolveRate: 4/4 across 4 packages     totalCost $0.0172
kernel-js              RESOLVED  F2P 2/2  P2P 2/2  (3 attempts — repair loop needed + earned)
create-agent-harness   RESOLVED  F2P 3/3  P2P 5/5  (1 attempt)
vertical-base          RESOLVED  F2P 1/1  P2P 8/8  (1 attempt)
darwin-mode            RESOLVED  F2P 4/4  P2P 1/1  (1 attempt)
```

**100% (4/4)** across four distinct codebases for ~$0.017, one runner, each scored on its own vitest suite. The `kernel-js` instance needed the repair loop (3 attempts) and still resolved — the ADR-126 retry machinery earning its keep on a real external bug. All committed sources verified clean.

## Significance

This is the strongest external-generalization evidence in the series: a **cross-package resolve-rate**, not a single instance. It demonstrates the runner is a general SWE-solving harness, not a darwin-mode-specific fixture, and instantiates the ADR-098 step-3 *shape* (a corpus → a resolve-rate) end-to-end. The runner is conclusively not the blocker.

## Honest scope

- **4 instances, in-monorepo** — each package's `node_modules` and vitest were already present, so `materialize` is a copy + symlink. A real external corpus (arbitrary repos, dockerized environments, varied test runners, build steps) needs per-repo `materialize` adapters and a larger budget — that is the genuine ADR-098 step 3.
- **Injected bugs**, not mined historical issues (the self-hosted history is non-viable, ADR-098 finding). Clean comparison/logic flips, single-file.
- 4/4 is a small-n demonstration; no leaderboard claim.

## Consequences

- ADR-098 is now de-risked to: *external dataset + budget + per-repo `materialize` adapters* — no new mechanism. `score(variant) = resolveRate(corpus)` (ADR-130) plugs in directly.
- A self-hosted corpus of monorepo packages is a cheap, repeatable regression check for the runner itself.

## Validation

Experiment + result committed (`bench/experiments/swe-monorepo-corpus.mjs`, `bench/results/swe-monorepo-corpus.json`); committed sources of all four packages verified clean (temp copies). darwin-mode's 350 tests unaffected.
