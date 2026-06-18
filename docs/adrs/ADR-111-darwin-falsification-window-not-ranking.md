# ADR-111: Darwin Mode — falsification: it's the context WINDOW SIZE, not the ranking (self-correction)

**Status**: Accepted (falsification — corrects ADR-109/110 overclaims)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-109 (surface gates real LLM), ADR-110 (capstone), ADR-085 (where ranking *did* matter)

> An adversarial review flagged that ADR-109/110 may show only a context-WINDOW-SIZE effect, not contextBuilder RANKING quality. I ran the proposed null-model falsification. The review was right. This ADR records the result and corrects the earlier framing — testing and falsifying our own claims is the point.

## The falsification (zero LLM calls — the fix is deterministic)

For each of three tasks (buggy file planted at rank 8/38/65 among same-overlap distractors), compare three context selectors at two windows; if a selector surfaces the buggy file, apply the known fix and let the **real test** be the verdict (`bench/experiments/falsify-context-selection.mjs`):

| selector | window 30 | window 70 |
|---|--:|--:|
| **real-contextBuilder** (its actual ranking) | 1/3 | 3/3 |
| **first-N** (no ranking — pure input order) | 1/3 | **3/3** |
| random-N (shuffled) | 3/3 | 3/3 |

**The real contextBuilder and a naive first-N selector give identical results at every window.** The ranking logic contributes nothing here; the only thing that changes solvability is the window *size* (how many files are returned). Reason: the distractor files share the buggy file's exact terms, so `buildContext`'s overlap scores are flat and it falls back to input order — i.e., it *is* first-N.

## Correction to ADR-109 / ADR-110

- **Was framed as:** "the harness's real contextBuilder *surface* gates / determines whether the LLM can fix the bug."
- **Honest claim:** the contextBuilder's **window parameter** (`.slice(0, N)`) gates how many files the LLM sees, and that gates solvability. The **ranking quality was never tested** (flat-overlap distractors), and a no-ranking first-N selector performs identically.
- **ADR-110 capstone** is therefore a **1-D, monotonic, noise-free window-size sweep** — a hill-climber (or random restart) would find `window ≥ 66` trivially. It demonstrates the surface→real-LLM→real-test **pipeline is wired end-to-end and that an evolvable surface parameter causally gates real-LLM capability** — it does **not** demonstrate non-trivial evolutionary search on the real substrate (that remains shown only on the mock substrate, ADR-105).

## What still stands

- The *pipeline* is real and end-to-end (real surface param → real LLM → real test). An evolvable surface parameter does causally control real-LLM capability. That is a true, useful result — just narrower than "ranking determines outcomes."
- Where ranking/quality genuinely matters is the **polyglot benchmark (ADR-085)**, which scores real model output by execution — that result is unaffected.
- The reproducible deception result (ADR-105, mock) is where evolutionary search beats greedy; it is untouched.

## The honest next step (per the review)

Before any SWE-bench run (ADR-098), demonstrate evolutionary search beating a random/greedy baseline **on the real substrate** with a *non-trivial* landscape: a task solvable only if **two** surfaces are improved simultaneously (the ADR-105 epistatic structure) **and** distractors that are semantically similar to the buggy file so **ranking quality** actually matters. If diversity-selection crosses it where greedy/random does not, the evolutionary-mechanism claim holds on the real substrate. If not, that is learned cheaply before spending SWE-bench tokens.

## Validation

Falsification harness + result committed (`bench/experiments/falsify-context-selection.mjs`, `bench/results/falsify-context-selection.json`). Correction notes added to ADR-109 and ADR-110. No package code changed; 349 tests unaffected. Negative result recorded, claims corrected.

---

## Update (ADR-113): the complete picture

ADR-111's "ranking irrelevant" finding holds **only for flat-overlap distractors**. ADR-113 ran the realistic case (buggy file highly relevant but positionally buried among low-relevance distractors): there the **relevance ranking IS causal** — `real-contextBuilder` solves at window 10 where `first-N` fails at window 30. Full statement: the contextBuilder gates capability through *both* window size (dominant in the flat case) *and* ranking quality (dominant when relevance varies, the realistic case). See ADR-113.
