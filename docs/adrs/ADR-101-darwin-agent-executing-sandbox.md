# ADR-101: Darwin Mode — the Agent-Executing Sandbox (the keystone unblock)

**Status**: Proposed (HEADLINE / keystone — design + evidence; implementation deferred)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (loop), ADR-071 (surfaces), ADR-091/092 (phenotype + steering), ADR-099 (audit), ADR-100 (Pareto). Supersedes the "future sandbox" notes scattered across 091/099/100 with one authoritative requirement.

## Context

> Seventeen ADRs built a rigorously-validated evolutionary engine — clade selection, hyperbolic niches + steering, epistatic crossover, FDR-controlled promotion, curriculum, Pareto. **Two independent measurements tonight show the engine is running without fuel.** This ADR names the fuel: a sandbox that executes the harness *as an agent*, so a variant's surface files actually shape its execution trace. It is the single keystone that activates the dormant stack.

## The evidence (measured tonight, not asserted)

1. **Behavioural manifold is degenerate (ADR-099):** `system-audit.mjs` measured `nicheEntropy = 0`, one occupied niche.
2. **Pareto axes are near-degenerate (this ADR):** a 6-generation `--selection pareto` run over 45 scored variants — every `finalScore = 0.985` (flat ceiling) and surface-bytes spanned only 8465–8514 (6 distinct sizes, <0.6%). The predicted "Mini vs Grand" bifurcation did **not** emerge.

## Root cause (one cause, many symptoms)

`sandbox.runVariantTask` scores a variant by running the **repo's test command**, which is **independent of the variant's seven harness surface files**. So:

- every variant's `RunTrace` is identical → behavioural phenotype collapses (ADR-091/092/099 dormant);
- `finalScore` is flat at the safety-gate ceiling → clade/score/efficiency selection can't rank (ADR-086/094 dormant);
- the only thing that differs at all is the surface *source bytes*, and the deterministic mutator perturbs those by <1% → Pareto parsimony can't discriminate (ADR-100 near-dormant).

**The harness surfaces never run.** They are scored as inert files. Until they execute and influence the trace, the entire diversity/selection apparatus has nothing to act on. This is the honest "what's missing" a DeepMind/FAIR reviewer would name first.

## Decision (requirement + design; implementation deferred)

`runVariantTask` must execute the variant's surfaces as an **agent loop** on a task, producing a **surface-dependent** trace. Two tiers, smallest-first:

- **Tier 1 — deterministic surface-driven executor (do this first; cheap, reproducible, no LLM).** A mock task whose execution path is a pure function of the surface *parameters*: the `retryPolicy`'s budget, the `contextBuilder`'s window, the `toolPolicy`'s ordering, the `planner`'s step list. Run the variant's modules (`import()` the surface files — they already export `plan()`, `build()`, `shouldRetry()`, …) against a scripted task with injected failures; record real steps/retries/nesting into the `RunTrace`. This alone makes traces vary by surface → `nicheEntropy > 0`, a real Pareto front, and live steering — **reproducibly**, and it is the right thing to validate the whole stack before spending LLM tokens.
- **Tier 2 — real LLM agent loop.** The surfaces drive an actual model on a real coding task (SWE-bench-style), capturing the genuine trajectory. This is the production substrate (ties into ADR-098) and where DGM/SWE-agent/OpenHands operate; far larger and gated on a real task corpus.

Safety is unchanged: execution stays inside the existing gate-first, shell-free, env-scrubbed sandbox (ADR-071); the surfaces are sandboxed code, the scorer/risk-budget/FDR gates still bound promotion.

## Why deferred (honest)

This is a major architectural build (dynamic surface execution, a task/trajectory model, failure injection) with real correctness and safety surface area — not a one-tick change, and not safe to rush autonomously overnight. The hourly horizon-tracker is researching the concrete design (how DGM/SWE-agent capture trajectories; the minimal deterministic executor). This ADR formalizes the requirement and the Tier-1-first plan so the next focused session executes it well.

## Success signal

The standing scoreboard already exists: when Tier 1 lands, `bench/system-audit.mjs` should report **`nicheEntropy > 0`** and the Pareto run should show **a genuine (capability/structure × parsimony) front** instead of a single 0.985/8465-byte point. That is the empirical moment the engine goes live.

## Consequences

- Reframes ADR-091/092/094/099/100 honestly: **architecturally ready, manifold dormant** — correct and tested, awaiting this keystone. Nothing is removed; nothing is faked.
- Gives the project one clear next objective instead of more breadth.
- No code change in this ADR; it is the design-of-record.
