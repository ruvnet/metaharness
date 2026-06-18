# ADR-114: Darwin Mode — the diversity-beats-greedy result is substrate-dependent (does NOT replicate on the real-surface substrate)

**Status**: Accepted (measured) — a non-replication that tempers ADR-105
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-105 (diversity beats greedy on the MOCK substrate), ADR-106 (Tier-2 agent substrate), the adversarial review's item C

> The review's highest-value next step was: replicate ADR-105's "diversity beats greedy on deception" on the *real* substrate before committing SWE-bench tokens — "if it does not replicate, you learn something important." It did not replicate. That is the finding, and it is more valuable than a confirmation.

## Experiment

A two-surface epistatic deception on the **agent substrate** (Tier-2, the variant's real surface CODE executes; zero LLM — the agent loop is deterministic): two easy tasks any variant solves, plus a treasure solvable only if **both** the contextBuilder window > 38 (surface the buried buggy file) **and** the retryPolicy `maxAttempts` > 3 (reach the required attempt). Single-surface improvements are score-neutral → epistatic. `evolve` with crossover + epistasis, 8 generations × 6 children, 3 seeds, `score` (greedy) vs `behavioral-diversity`. (`bench/experiments/real-substrate-deception.mjs`.)

## Result (real, 2026-06-18)

| substrate | landscape | greedy `score` | `behavioral-diversity` |
|---|---|--:|--:|
| mock (ADR-105) | window≥45 ∧ retry>3 | 0/5 | **5/5** |
| **agent (real surface code, this)** | window>38 ∧ retry>3 | **3/3** | 2/3 |

On the real-surface substrate, **greedy+crossover crossed the deception on all 3 seeds; diversity on only 2/3** — the reverse of the mock finding.

## Interpretation (honest)

- The **diversity-beats-greedy advantage is NOT universal; it is substrate/landscape-dependent.** ADR-105's result holds for the *mock scorer*, whose plateau is perfectly flat (every safe variant = 0.985), so greedy has no gradient and its crossover pairs the wrong (tied, earliest-inserted) parents. On the *agent* substrate, the Tier-2 traces differ across variants (retries, context size, durations), so `finalScore` has texture even on the "plateau" — greedy gets a usable gradient, selects the partial-solvers as parents, and **crossover combines the two stepping-stones for it too**. Diversity's niche-spreading then offers no edge (and can even pick less-fit far-niche parents).
- **Caveat: n=3 seeds.** 3/3 vs 2/3 is not a statistically strong separation; the firm claim is the *non-replication* (diversity did not beat greedy; greedy was competitive-or-better), not "greedy is better." More seeds would sharpen it.
- This **tempers ADR-105**: that result stands *as measured on the mock substrate*, but must not be generalized to "diversity selection is better for deceptive real tasks" — the real substrate here shows the opposite tendency.

## Consequences

- A real, useful de-risking *before* ADR-098: do not assume the mock-substrate selection findings transfer to real evaluation. The selection-strategy choice for real SWE tasks is an open empirical question, not settled by ADR-105.
- The mechanism that actually crosses the deception on both substrates is **crossover** (recombining stepping-stones), not the parent-selection strategy per se — crossover is the load-bearing piece; the selection strategy is secondary and substrate-dependent.
- Strengthens credibility: a prior headline result was stress-tested on a more realistic substrate and found not to generalize — recorded, not buried.

## Validation

Harness + result committed (`bench/experiments/real-substrate-deception.mjs`, `bench/results/real-substrate-deception.json`). Zero LLM calls (deterministic agent loop). 350 tests unaffected. A strong-deception variant (window>50 ∧ retry>4) was crossed by neither strategy (consistent with ADR-105's strong-deception ceiling).

---

## Correction (ADR-115)

This ADR's *mechanistic* claim — "crossover is the load-bearing piece" — was **refuted** by the crossover ablation (ADR-115): with crossover OFF, the treasure is still crossed (2/2 for both selection strategies). The actual mechanism is **whole-archive retention (ADR-073)** enabling *sequential* single-surface accumulation across generations — no recombination needed. ADR-114's data (diversity did not beat greedy on the agent substrate) stands; its crossover attribution does not. See ADR-115.
