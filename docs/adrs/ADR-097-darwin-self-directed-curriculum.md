# ADR-097: Darwin Mode — self-directed curriculum (difficulty ladder)

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-076 (graded suite + `difficulty`), ADR-087 (graded promotion), ADR-091/092 (hyperbolic niches + steering). Addresses the horizon-tracker's **Gap 3** (benchmark saturation / degenerate manifold).

> The recurring honest finding across ADR-091/092/095: every selection refinement is *latent* until the search space has gravity. An easy suite scored in full from generation 0 never forces struggle, so the high-complexity Poincaré frontier stays empty. This ADR adds a difficulty ladder over the EXISTING graded tasks so harder problems arrive as competence grows.

## Context

`BenchmarkTask` already carries `difficulty: 1..5` (ADR-076), but `evolve --bench` scored every variant on the full suite immediately. If the easy tiers are trivial (the common case), the population saturates at the ceiling and never has to reach for hard behaviour — the manifold's complex frontier is uninhabited not because steering fails, but because nothing rewards complexity yet. The fix is curriculum learning: sequence the tasks, admit harder tiers only once the easier ones are mastered.

## Decision

Add `src/curriculum.ts` (pure, deterministic, no LLM, no fabrication):

- `admittedTasks(tasks, level)` — tasks with `difficulty ≤ level`.
- `curriculumSuite(suite, level)` — a **re-hash-pinned** sub-suite of the admitted tasks (still passes `verifySuite`; selecting a tier is not tampering), with a fallback to the lowest tier so a generation is never scored on an empty suite.
- `maxDifficulty(suite)` and `nextCurriculumLevel(level, meanSolveRate, cap, threshold)` — escalate one rung only when the population's mean solve rate ≥ `threshold` (default 0.9), capped at the suite's top rung.

Wired into `evolve()` behind `EvolutionConfig.curriculum` (with `benchSuite`): each generation scores only the admitted tier; after evaluation, the mean child solve rate decides whether to escalate. CLI: `--curriculum` (`--curriculum-threshold` via config). Default off → full-suite scoring unchanged.

## Honest scope

This is curriculum *sequencing over real, human-authored graded tasks* — it does not synthesize new tasks. It only bites when the suite actually contains a difficulty spread (a trivial single-tier suite has nothing to ladder). The LLM-synthesized adversarial-task generator (the fuller SDCL vision) is a future extension behind the same `admit()` seam; it is deferred because reliably synthesizing *runnable* harder tests for an arbitrary repo is unsolved and would risk fabricated/broken commands.

## Consequences

- With a graded suite, the population is forced up the difficulty ladder as it improves — the mechanism that should finally populate the high-radius Poincaré niches and make steering (ADR-092) and the ablation (ADR-095) *live*-meaningful rather than synthetic.
- Composes with FDR control (ADR-096), clade selection (ADR-094), and the risk budget (ADR-090).
- Provides the substrate for the "Adaptation Latency" benchmark metric (generations to first solve of a newly-admitted hard tier).

## Validation

`packages/darwin-mode` — 336 tests (was 331; +5): admits by difficulty, `curriculumSuite` re-pins a verifiable sub-suite, never yields an empty suite (lowest-tier fallback), `maxDifficulty`, and escalation only on mastery (capped at the top). Default path unchanged and green.
