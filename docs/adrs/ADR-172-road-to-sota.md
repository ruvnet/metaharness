# ADR-172: Road to SOTA — pushing SWE-bench Lite past 70%

**Status**: Proposed — roadmap; levers prioritized by measured ROI
**Date**: 2026-06-22
**Project**: `ruvnet/agent-harness-generator`
**Builds on**: ADR-148/152/154 (tiering, 58.3%), ADR-153 (agentic loop), ADR-169 (patch-memory /
router / anti-thrash), ADR-170 (stateful-PTY loop), ADR-171 (web-UI). Grounded in RESULTS §22–29.

## Context — what we now know (measured, this arc)

1. **The 58.3% ceiling was MODEL-bound at the Sage tier, not paradigm-exhausted.** Swapping Sage
   opus-4 → **opus-4.8** recovered **35.4%** of the residual tail opus-4 scored 0 on (identical inputs),
   *cheaper* (~$0.65 vs $1.85/inst), lifting the blended agentic 3-tier to **64.7%** [59.1, 69.9]
   (RESULTS §27–29) — and that's a lower bound (partial tail coverage).
2. **Two complementary frontiers, not a fork:** the agentic loop is the **cost** frontier (46.3% at
   ~$0.03–0.09/inst); a stronger frontier Sage is the **quality** frontier. Stack both.
3. **Difficulty is not predictable from issue text** (E2 router AUC 0.505) — don't gate on a learned
   difficulty score; route by *tier outcome* (escalate whatever the cheaper tier failed), not prediction.
4. **The residual tail correlates across same-generation tiers** — only a *stronger* model or a
   *different interaction primitive* moves it.

External 2026 SOTA for reference (not our metric): ~70% SWE-bench Pro, 80%+ Verified (`mini-SWE-agent`,
`Live-SWE-agent`). Ours is **Lite** — not directly comparable; we track our own batch numbers.

## Decision — the lever stack to SOTA, in measured-ROI order

**Tier A — quality frontier (cheapest wins first):**
1. **Full Opus-4.8 Sage over the whole residual tail** (in flight). Projected **~71%** [tightening CI].
   ~$36, `--max-cost`-guarded. *This alone likely sets a clean new headline.*
2. **Opus-4.8 as the Sage tier from scratch** (not just patching opus-4's misses) — re-escalate the
   *entire* post-Scholar tail with opus-4.8. Removes the opus-4 path-dependence; expected ≥ (1).
3. **Best-of-N at the Sage tier** — sample opus-4.8 k=3–5× per hard instance, keep the patch that passes
   the instance's FAIL_TO_PASS in the sandbox. Test-gated selection turns variance into recall.
   Expected +several pp on the tail; cost = k× Sage (gate with `--max-cost`).

**Tier B — interaction primitive (the architectural lever, ADR-170):**
4. **Stateful-PTY agent loop** — persistent bash in the testbed container, `execute_bash` / `read_file`
   / `edit_file` / `finish_task`, 50 turns, scratchpad. Shatters the single-shot "emission wall"; this is
   the mechanic behind the 70–80%+ external tier. $0 to build (core + offline tests reuse the ADR-169
   anti-thrash); needs budget to run. Pair with opus-4.8 as the driver.
5. **MCTS / parallel rollouts** (ADR-170 §6) — on a hard instance, fork container state into N branches,
   run each PTY loop, prune by test outcome, compound the winner. Pushes toward 80%+; converts cost from
   pennies to dollars/inst → trigger only on the post-Sage tail.

**Tier C — compounding (ADR-169, now unblocked):**
6. **Patch-memory RAG (E3)** — E1 produced a real trajectory dataset; index resolved (issue→patch)
   pairs, inject gated few-shot. Makes runs compound; $0 retrieval (BM25 core shipped, dense rerank opt-in).

## Gates (discipline, unchanged)
- Only **batch-eval** numbers are authoritative; in-loop drifts 1.5–5×. Report Wilson 95% CI.
- Every lever batch-verified before adoption; a lever that doesn't move resolve-rate is dropped.
- **Cost-per-resolve is the objective**; `--max-cost` (in-solver, ADR shipped) bounds every paid run.
- SWE-bench Lite (our number) kept strictly separate from Verified/Pro (external SOTA).

## Consequences

### The honest ceiling (ADR-170 §6.3)
Every lever here optimizes an agent over an **existing** codebase — the Maintainer task SWE-bench
measures. Brute-forcing parallel PTY + best-of-N + a frontier Sage can plausibly reach **~75–85% on
Lite**, but none of it makes the system an **Architect** (zero-to-one design). The durable product
framing remains "autonomous Senior Staff Maintainer," and that is exactly what SWE-bench rewards.

### Immediate next step
The in-flight full-tail Opus-4.8 run (lever 1) → batch → new headline. Then lever 2 (Sage-from-scratch)
on a top-up, then build lever 4 (PTY loop) at $0 so it's ready. Expected trajectory: **64.7% → ~71%
(lever 1) → mid-70s (levers 2–3) → 80%+ (levers 4–5, architectural).**
