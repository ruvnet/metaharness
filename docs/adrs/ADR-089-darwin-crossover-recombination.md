# ADR-089: Darwin Mode — genetic crossover (surface recombination)

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-071 (mutation surfaces + safety gate), ADR-073 (archive tree), ADR-084 (failure-driven mutation), ADR-088 (MAP-Elites selection)

> Until now a child came from ONE parent via ONE mutation. But two high-fitness parents may each carry a *different* good surface — a better `planner` here, a better `retryPolicy` there. Mutation alone cannot combine them. This ADR adds opt-in crossover: recombine two parents' surfaces into one child.

## Context

A harness variant is a directory of seven independent surface files (ADR-071). Evolutionary search over such a genome benefits from **recombination**, not just point mutation: if parent A evolved a strong `reviewer` and parent B a strong `contextBuilder`, a child that inherits A's reviewer and B's context builder can outperform either — something single-surface mutation can only reach by luck across many generations. MAP-Elites (ADR-088) now keeps elites in *distinct* surface niches, which makes recombining across niches especially worthwhile.

## Decision

Add `createCrossoverVariant(parentA, parentB, workRoot, generation, index, seed)`:

- Copy parentA's directory, then replace a **deterministic, non-empty, proper subset** of surface files with parentB's versions (bit-per-surface from a seeded hash; forced to be neither all-A nor all-B). The child inherits some surfaces from each parent.
- **Recombination only — no code is generated.** Every adopted file already passed `validateGeneratedCode` when its parent was built; we re-validate defensively and skip any file that would fail, so the child always still passes `inspectVariant` (ADR-071 hard gate).
- **Tree invariant preserved.** The archive is a strict tree with a single `parentId` (ADR-073). Crossover records **parentA** as the tree parent and names **parentB** in the `mutationSummary`, so every tree-based invariant and test holds unchanged.

Wire into `evolve()` behind `EvolutionConfig.crossover?: boolean` (default **false**). When true and a generation has **≥2 parents**, the first child of each parent recombines with the next parent (deterministic pairing); the remaining children are ordinary failure-driven mutations. CLI: `evolve --crossover`.

## Consequences

- Opt-in runs can combine beneficial surfaces discovered on separate lineages in a single generation, not only over many — the recombination half of evolutionary search.
- Deterministic (seeded subset, no wall-clock), so the opt-in path stays reproducible.
- Crossover needs ≥2 parents, which is exactly when the population is diverse — it pairs naturally with `--selection quality-diversity` (ADR-088), which keeps parents in distinct niches.
- Default behaviour (mutation-only) is unchanged; all prior tests are byte-identical.

## Validation

`packages/darwin-mode` — 302 tests (was 299; +3): a crossover child inherits a proper non-empty mix from both parents (markers prove ≥1 surface from each, all seven present), records parentA as tree parent + names parentB, and is deterministic for fixed `(generation,index,seed)` while still passing the hard gate. Default-path suites unchanged and green.
