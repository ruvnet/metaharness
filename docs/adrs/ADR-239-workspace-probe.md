# ADR-239: @metaharness/workspace-probe — evaluation + Darwin-Mode bridge for workspace-lens

- **Status**: Accepted — logic developed + validated in isolation against the published `@metaharness/workspace-lens@0.1.0` ($0, 9 tests); re-homed into the monorepo with a local workspace dep.
- **Date**: 2026-07-07
- **Deciders**: ruv
- **Tags**: interpretability, jacobian-lens, workspace-lens, darwin-mode, mutation-evidence, flywheel, eval, ai-safety, metaharness
- **Extends**: ADR-238 (`@metaharness/workspace-lens` — the primitive)
- **Artifacts**: `packages/workspace-probe/src/{probe,index}.ts`, `packages/workspace-probe/__tests__/probe.test.ts`

---

## 1. Context

ADR-238 shipped `@metaharness/workspace-lens`: it reads the model's internal workspace into a
`WorkspaceLensReceipt` per decision. That's the primitive. What was missing is the *application* — how
MetaHarness evaluation and Darwin Mode consume those receipts. Adding it to workspace-lens would couple
the measurement primitive to flywheel/Darwin concerns; a thin separate package keeps the primitive clean.

## 2. Decision

Ship `@metaharness/workspace-probe` — a pure, dependency-light bridge (only the workspace-lens types):

- **`workspaceProbeScore(receipts, {driftThreshold})`** → a flywheel-consumable evaluation surface
  (`score = cleanFraction` = fraction of decisions with no critical trigger and drift below threshold),
  plus `meanDrift` / `flagRate` / `criticalRate`.
- **`gradeMutationByWorkspace(baseline, mutant, opts)`** → a Darwin-Mode **veto**: reject a mutation that
  raises `criticalRate`, raises `meanDrift` beyond tolerance, or drops `cleanFraction` beyond tolerance —
  even if final answers improved. Structurally-brittle mutations lose the workspace's grip on the right
  concept. It **pairs with** the gold/final-answer gate (keep only if both pass) and never weakens it.

## 3. Consequences

- MetaHarness evaluation gains a `workspace_probe` score; Darwin Mode gains internal-process mutation
  evidence beyond black-box accuracy. `meetsPromotionRule` is untouched — this is an ADDITIONAL veto.
- Honest scope: the probe is only as good as the fitted lens + concept vectors it's fed (ADR-238); it is a
  measurement/gating aid, not a correctness oracle. Empty receipt sets score 0 (nothing witnessed → no
  credit), so coverage matters.
