# ADR-113: Darwin Mode — contextBuilder ranking IS causal when relevance varies (completes ADR-111)

**Status**: Accepted (measured) — completes the ADR-111 falsification into the full picture
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-111 (ranking irrelevant for flat-overlap distractors), ADR-109 (surface gates real LLM), ADR-085 (ranking matters under execution scoring)

> ADR-111 honestly showed the contextBuilder's *ranking* contributed nothing — but only because its distractors shared the buggy file's terms (flat overlap → ranking degenerates to input order). That left an open question the review implied: does ranking matter when file relevance actually *varies*? It does. This closes the loop.

## The test (zero LLM — deterministic fix)

The buggy file has **high** relevance to the prompt ("fix merge intervals") but is **buried at input position 50**, behind 50 **low-relevance** distractors (no shared terms). Two selectors at two windows; if the buggy file is surfaced, apply the known fix and let the **real test** decide (`bench/experiments/ranking-matters.mjs`):

| selector | window 10 | window 30 |
|---|--:|--:|
| **real-contextBuilder** (relevance ranking) | **solves** | **solves** |
| first-N (position, no ranking) | fails | fails |

The relevance ranker surfaces the buried-but-relevant bug even at window 10; the position-based selector misses it at window 30 (the bug sits at index 50). **Ranking quality is causal here** — it is not reducible to window size.

## The complete picture (both ADRs together)

| distractor design | does ranking matter? | which dominates |
|---|---|---|
| **flat overlap** (ADR-111) | no | window size only |
| **varied relevance** (ADR-113, realistic) | **yes** | relevance ranking surfaces the right file regardless of position/window |

So the honest, full statement: **the contextBuilder surface gates real-LLM capability through *both* its window size *and* its ranking quality; ranking dominates when file relevance varies (the realistic case for real repositories), window dominates only in the degenerate flat-relevance case.** ADR-111's correction stands for the flat case; ADR-109's "surface determines outcomes" is rehabilitated for the realistic case.

## What this does and does not change

- **Rehabilitates** the surface-quality-is-causal claim for realistic, varied-relevance file sets — the regime real SWE tasks live in.
- **Does not** rehabilitate ADR-110's capstone as "non-trivial evolutionary search" — that remains a 1-D window sweep (ADR-111 correction holds); a genuine real-substrate search demonstration still needs the two-surface epistatic experiment (the review's open item).
- Both experiments are zero-token and deterministic, so the picture is reproducible.

## Validation

Harness + result committed (`bench/experiments/ranking-matters.mjs`, `bench/results/ranking-matters.json`). Cross-referenced from ADR-111. 349 tests unaffected.
