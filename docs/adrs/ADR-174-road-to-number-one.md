# ADR-174: Road to #1 overall — DeepSeek-V4-Flash base + Test-Critic + Conformant MCTS + Opus-Sniper

**Status**: Implementing — L0.6+L2 built & measured (DeepSeek-only floor 20.0%); asymmetric MiniMax-patch swap next
**Date**: 2026-06-22
**Project**: `ruvnet/agent-harness-generator`
**Builds on**: ADR-173 (conformant leaderboard path). The conformant L1 (MiniMax M2.5, linear loop)
showed a **low submit-rate** — a linear agentic loop hits a context-collapse wall and won't reach
80%+. To take #1 *overall* (beat the 80% brute-force SOTA AND hold the Pareto cost crown) we pair
cheap 2026 open-weight reasoning with a search architecture.

## Decision — a 4-layer conformant stack

**1. Base = DeepSeek-V4-Flash (the arbitrage engine).** Verified on OpenRouter at **$0.09/$0.18 per M**
(cheapest reasoning tier; the board shows the V4 family ~70%). So cheap we don't run it once — we fuel
massive parallel search with it.

**2. Test-Critic — the self-written conformant oracle (L0.6, BUILT + validated).**
The agent writes `reproduce_bug.py` from the issue; we run it on the **unmodified** repo inside the
instance Docker image (conformant — never the gold test). A VALID repro must **FAIL on the buggy code**.
If it passes, the critic makes the model rewrite until it produces a clean failing test. Result: a
mathematically grounded, leaderboard-legal **gold-test proxy**. *Validated $0 on a cached image:
injection works, fail-on-base → `failed`, pass-on-base → `passed` (rewrite).* Linchpin risk: does the
cheap model write a *valid* failing repro at high rate? — measured next on a real model run.

**3. Conformant MCTS (L2).** With a valid repro in hand, switch from trajectory-iteration to
trajectory-**search**: fork the container state into k=5–10 branches, have DeepSeek-V4-Flash attempt k
*different* fixes in parallel, apply each + run the self-written repro, prune failures, keep a winner.
The repro (not the gold test) is the deterministic filter → recall spikes ~15–20% at ~$0.05/instance.

**4. Opus-Sniper (L3).** For the ~10% bedrock where all k branches fail the repro, escalate **that one
instance** to Claude Opus 4.8. Deployed on ~30/300 → total run stays under ~$50 while getting 88%-tier
reasoning exactly where it's needed.

## Targets (PROJECTIONS — not measured; gated on conformant batch + Wilson CI)
Stack projects **~85% Lite for <$40** and a Top-5 Verified at a fraction of the leaders' $3–5/inst —
#1 on performance *and* the Pareto frontier. **These are hypotheses.** Each layer is adopted only after
a conformant batch shows it moves resolve-rate; the linear-loop L1 already proved cheap-model-on-a-weak-
loop underperforms, so nothing here is assumed.

## Gates (unchanged)
Conformant (leakage-guarded, no gold oracle in-loop); only batch-eval numbers (Wilson 95% CI);
`--max-cost` bounds every paid run; report $/resolve; submit via PR to `swe-bench/experiments`.

## Build order
- **L0.6 Test-Critic** — ✅ built (`test-critic.mjs`) + Docker injection validated ($0).
- **L1′** — swap base to DeepSeek-V4-Flash; measure repro-validity rate + single-attempt conformant score.
- **L2 MCTS** — ✅ built + measured (`solve-mcts.mjs`); DeepSeek-only floor 5/25=20.0%. Bottleneck = empty patches (44% attempt rate), not selection (45% conditional resolve).
- **L2′ asymmetric swap** — `--patch-model minimax/minimax-m2.7` (DeepSeek stays Test-Critic); measuring the recall lift next.
- **L3 Opus-Sniper** — repro-gated single-instance escalation, `--max-cost` capped.

## L2 measured floor + the funnel (2026-06-22) — DeepSeek-only, k=5, conformant

First authoritative conformant batch (gold `FAIL_TO_PASS`, no oracle in-loop), 25-instance pilot:
**5/25 = 20.0% [Wilson95: 8.9%, 39.1%], $0.587.** The funnel is the real finding:

| stage | rate | reading |
|------|------|---------|
| Repro-validity | 17/25 = **68%** | the Test-Critic oracle works → keep DeepSeek-V4-Flash on `--model` (the critic) |
| Patch-attempt rate | 11/25 = **44%** | **the bottleneck** — single-shot DeepSeek returns an empty/unapplicable patch 56% of the time |
| Conditional resolve | 5/11 = **45%** | **the multiplier** — when a real patch exists, the repro-gated MCTS picks a gold-correct one ~45% of the time |

**Interpretation:** the MCTS selection is sharp; it is *starved for candidate volume*, not picking badly. The
20% floor is dominated by empty patches, not wrong reasoning.

**The asymmetric swap (next lever, in code as `--patch-model`):** keep DeepSeek-V4-Flash as the $0.09/M
Test-Critic (cheap filtering), swap **MiniMax M2.7 ($0.25/M) for patch *generation* only** — spend the
extra dollars precisely to convert the 14 empty patches into real candidates. *If* MiniMax fills those
and the 45% conditional-resolve holds, the projected overall lands in the 70%+ zone. **Projection — gated
on the next conformant batch + Wilson CI.** The 45% conditional rate is the load-bearing assumption.

## L2′ result (2026-06-22): the asymmetric MiniMax swap is FALSIFIED

Same 25-instance Lite pilot, DeepSeek-V4-Flash Test-Critic + **MiniMax M2.7 patch generation**, gold batch:

| metric | DeepSeek floor | MiniMax-M2.7 patch | verdict |
|------|------|------|------|
| **Resolved/25** | 5/25 = **20.0%** | 5/25 = **20.0%** | **no change** |
| Non-empty patches | 11/25 (44%) | 12/25 (48%) | marginal |
| Conditional-resolve | 5/11 = 45% | 5/12 = 42% | flat/slightly down |
| Cost | $0.59 | $1.29 (**2.2×**) | worse |

**A stronger, 2.2×-pricier patch model did not move the conformant resolve rate.** The empty-patch
bottleneck is therefore **structural, not model-bound**: the brittle single-shot search/replace applier
(`applyEdit` exact/fuzzy match) drops ~50% of patches regardless of model, and the conditional-resolve
sits at ~42–45%. **Decision: do NOT adopt MiniMax for patching** (no lift, higher cost); DeepSeek-V4-Flash
stays the patch model too.

**Next lever (structural, not a bigger model): a robust patch applicator.** Replace single-shot
search/replace with the agentic read-then-edit loop per branch (or whole-function rewrite / unified-diff
with fuzzy hunks). This lifts *attempt-rate* for both models at ~zero extra model cost — the only lever
the data says can move the floor. Then re-measure conditional-resolve and decide on k=10 + Opus sniper.

## Honest ceiling (carried from ADR-170 §6 / ADR-172)
Even at 85% this is an autonomous **Senior Staff Maintainer**, not an Architect. SWE-bench rewards
exactly the maintainer task — which is why the stack can win it.
