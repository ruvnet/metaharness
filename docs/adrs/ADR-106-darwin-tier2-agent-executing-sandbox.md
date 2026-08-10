# ADR-106: Darwin Mode — Tier-2 agent-executing sandbox (real surface code runs)

**Status**: Accepted (implemented + measured)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-101 (the keystone requirement), ADR-102 (Tier-1 deterministic mock), ADR-071 (safety sandbox), ADR-104 (mutation exploration). This is **Tier 2** of ADR-101.

## Context

> ADR-102 (Tier 1) made traces depend on surface *parameters* (regex-extracted). This ADR runs the surfaces' *actual code*: a variant's real `planner` / `contextBuilder` / `retryPolicy` / `toolPolicy` modules execute in a child process and drive the agent loop. The harness's evolved logic — not a proxy for it — now decides the outcome.

## Decision

- **`src/tier2-driver.ts`** (ships compiled as `dist/tier2-driver.js`) runs in a child `node --experimental-strip-types` process so it can `import()` the variant's `.ts` surfaces directly (they are self-contained — no cross-file imports — so each strips + loads standalone). It drives a deterministic agent loop calling the **real** exports: `createPlan` (must yield a verify step), `buildContext` (ranks + windows the candidate files), `decideRetry` (persistence under a failure classification), `orderKinds`. It prints a JSON trace; `durationMs` is loop-derived, not wall-clock ⇒ reproducible.
- **`src/tier2-sandbox.ts`** spawns the driver via `execFile` (shell-free, argv-split — no injection), under a **scrubbed env** (PATH + identifiers only) and a wall-clock **timeout** — the same safety posture as ADR-071. The gate (`inspectVariant`) has already cleared the variant before any execution. A child error degrades to a clean "unsolved" trace, never crashing the loop. Driver path resolves to the sibling `dist` artifact (robust from both `dist/` and `src/`).
- Wired into `evolve()` as `sandboxMode: 'agent'` (default `'real'` unchanged). Requires Node ≥ 22.

## Measured results (real, 2026-06-18)

**Differentiation by real code** — the default agent suite places each buggy file *after* equal-overlap distractors, so it survives into the context window only if the variant's `buildContext` window is wide enough:

| variant | contextBuilder window | tasks solved |
|---|--:|--:|
| baseline | 30 | 1/3 |
| widened | 50 | 2/3 |
| widened | 80 | 3/3 |

The variant's *actual* contextBuilder logic — executed in a child process — determines what it sees and thus what it solves.

**Self-improvement under Tier-2** — `evolve()` in `sandboxMode: 'agent'` (8 gens, behavioral-diversity, crossover):

```
gen 0: 0.618 (window 30)  →  gen 3: 0.802  →  gen 4: 0.985 (window evolved to 65)
```

The loop evolves the contextBuilder's **real code** (window 30 → 65) and climbs `finalScore 0.618 → 0.985` — self-improvement driven by executing the surfaces, the strongest validation of the whole stack short of a real LLM task.

## Honest scope

- The agent loop and tasks are still **synthetic** (a deterministic file-location task), not a real LLM solving a real repo issue — but the *harness code under evaluation is real and executed*, which is the Tier-1 → Tier-2 leap. The real-LLM-on-real-SWE-tasks substrate (ADR-098) is the remaining step.
- Requires Node ≥ 22 (`--experimental-strip-types`); the e2e test skips below that.
- The three callable surfaces that matter most here are planner/contextBuilder/retryPolicy; reviewer/memory/score policies are imported-but-secondary in this driver.

## Consequences

- The keystone (ADR-101) is realized: surfaces' real code drives evaluation, and the loop self-improves on it. Tier-1 (mock) remains the fast, LLM-free, fully-reproducible default for the diversity/selection experiments; Tier-2 is the higher-fidelity substrate.
- Clear next step: swap the synthetic agent loop for a real LLM coding task (ADR-098), reusing this exact child-execution + safety + trace machinery.

## Validation

`packages/darwin-mode` — 349 tests (was 348; +1 e2e, Node-≥22-gated): a wider-window variant solves strictly more agent tasks than baseline, proving real surface code drives the outcome. Default/`mock` paths unchanged.
