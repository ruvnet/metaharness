# ADR-116: Darwin Mode — retention ablation (partial support, inconclusive; thread wound down)

**Status**: Accepted (measured — partial/inconclusive, honestly)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-115 (archive retention is the mechanism), ADR-073 (retention), ADR-114

## Context

> ADR-115 claimed whole-archive retention enables sequential two-surface accumulation, making crossover optional — and predicted that *without* retention, crossover becomes necessary. This ablation tests both halves. The first is partially supported; the second is not. Recorded honestly, including the inconclusiveness.

## Ablation

Added `EvolutionConfig.selectionPool: 'archive' | 'generation'` (memoryless (μ,λ): parents only from the current generation's children). Crossed with crossover on/off, greedy selection, agent substrate, zero LLM, 2 seeds (`bench/experiments/retention-ablation.mjs`):

| config | crossed treasure |
|---|--:|
| archive (retain), crossover on | 2/2 |
| archive (retain), crossover off | 2/2 |
| memoryless, crossover on | 1/2 |
| memoryless, crossover off | 1/2 |

## Reading (honest)

- **Retention helps** (archive 2/2 vs memoryless 1/2): partial support for ADR-115's core — the retained archive aids sequential accumulation. *But* memoryless still crossed 1/2, so retention is not strictly required either; even (μ,λ) sometimes carries the neutral intermediate forward when it lands in the top-2 by tie/insertion.
- **The corollary FAILS**: crossover did **not** rescue the memoryless case (1/2 with crossover, 1/2 without). So "without retention, crossover becomes necessary" is **not** supported by this data. Crossover remains non-decisive in every condition tested (ADR-115/116).
- **n=2 — inconclusive.** 2/2 vs 1/2 is suggestive, not significant. No firm mechanistic claim is warranted beyond "retention appears to help; crossover does not appear decisive."

## Decision: wind down the mechanistic-ablation thread

Five ablation experiments (105/114/115/116 + the strong-deception probe) have characterized the synthetic two-surface deception about as far as is useful: **crossover and diversity-selection are not decisive on these neutral-intermediate landscapes; archive retention + bidirectional mutation do most of the work; a regime where recombination is strictly necessary was not found** (it would require *harmful*, pruned intermediates, which Darwin's design resists). Further fine ablations at n=2–3 are noise-limited and academic relative to the project goal. The honest, useful conclusions are recorded; `selectionPool` remains as a genuinely-useful committed knob ((μ,λ) vs (μ+λ)).

## Consequences

- The selection-mechanism story is now *characterized and bounded*, not over-sold: on these landscapes the engine's retained archive is the workhorse; crossover/diversity are optional and substrate/landscape-dependent.
- The genuinely-next frontier is unchanged and is **not** more synthetic ablation: it is ADR-098 (real LLM on a real multi-file SWE corpus), where the surfaces and tasks are rich enough that these mechanisms may finally separate — a deliberate, token-costly, user-directed build.

## Validation

Harness + result committed (`bench/experiments/retention-ablation.mjs`, `bench/results/retention-ablation.json`); `selectionPool` config added (350 tests unaffected). Inconclusive result recorded rather than dropped or spun.
