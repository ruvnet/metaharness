# ADR-115: Darwin Mode — crossover ablation refutes "crossover is load-bearing"; the archive does the work (corrects ADR-114)

**Status**: Accepted (measured) — refutes a hypothesis from ADR-114
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-114 (substrate-dependence; claimed crossover load-bearing), ADR-073 (whole-archive retention), ADR-104 (bidirectional mutation), ADR-089 (crossover)

> ADR-114 concluded "crossover is the load-bearing mechanism, not the selection strategy." That was a hypothesis from runs that all had crossover ON. The clean test is an ablation. It refutes the claim — and reveals the actual mechanism is the retained archive.

## Ablation (agent substrate, zero LLM)

The same two-surface epistatic treasure (needs contextBuilder window > 38 AND retryPolicy maxAttempts > 3), `{score, behavioral-diversity} × {crossover on, off}`, 2 seeds (`bench/experiments/crossover-ablation.mjs`):

| config | crossed treasure |
|---|--:|
| crossover=true, score | 2/2 |
| crossover=true, behavioral-diversity | 1/2 |
| **crossover=false, score** | **2/2** |
| **crossover=false, behavioral-diversity** | **2/2** |

**Crossover OFF crosses the treasure just as well (2/2).** So crossover is *not* necessary — ADR-114's "crossover is the load-bearing mechanism" is **refuted**.

## The actual mechanism

The two-surface treasure is not a hard plateau on this engine, because of **whole-archive retention (ADR-073)**: a variant that improves only one surface (e.g. window→40, still scoring 2/3 — a *neutral* intermediate) is **retained** in the archive and can be **re-selected** as a parent later; a subsequent single-surface mutation on it (retry→4) then crosses the treasure. The two surfaces accumulate **sequentially across generations within a lineage** — no recombination required. Bidirectional mutation (ADR-104, both surfaces now grow upward) is what makes each step reachable.

In other words: **the retained archive already performs the stepping-stone preservation that crossover and quality-diversity selection are designed to provide.** That also explains ADR-114's other half — why `behavioral-diversity` showed no advantage over `score` on the agent substrate: the archive, not the selection strategy, is doing the diversity-preservation.

## Correction to ADR-114

- ADR-114's data stands (diversity did not beat greedy on the agent substrate). But its *mechanistic* claim — "crossover is load-bearing" — is wrong; this ablation shows crossover is not necessary. The load-bearing mechanism is **archive retention + bidirectional sequential mutation**.
- Honest implication: the deceptions tested so far (085/105/114) are crossable by sequential accumulation because Darwin retains and re-selects neutral intermediates. A landscape that genuinely *requires* crossover/diversity would need intermediates that are actively *harmful* (pruned or never re-selected), not merely neutral — which the archive's retain-everything design specifically resists. Demonstrating a regime where crossover/diversity is strictly necessary remains open.

## Consequences

- A real architectural insight, earned by refuting our own prior tick: **ADR-073's whole-archive retention is a more powerful stepping-stone preserver than expected** — it makes crossover and QD-selection *optional* for sequential two-surface accumulation. That is a strength of the engine, and a caveat on how much credit crossover/diversity deserve.
- Two consecutive honest corrections (ADR-114 tempered ADR-105; ADR-115 refutes ADR-114) — the series' value is that it keeps testing its own claims to destruction.

## Validation

Ablation harness + result committed (`bench/experiments/crossover-ablation.mjs`, `bench/results/crossover-ablation.json`). Zero LLM. Correction noted on ADR-114. 350 tests unaffected. Caveat: 2 seeds (the firm claim is the refutation — crossover-OFF clearly crosses).
