# ADR-174: Road to #1 overall — DeepSeek-V4-Flash base + Test-Critic + Conformant MCTS + Opus-Sniper

**Status**: Proposed — L0.6 built + validated; L1–L3 staged
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
- **L2 MCTS** — Docker-forking k-branch runner gated by the repro (the real recall lever).
- **L3 Opus-Sniper** — repro-gated single-instance escalation, `--max-cost` capped.

## Honest ceiling (carried from ADR-170 §6 / ADR-172)
Even at 85% this is an autonomous **Senior Staff Maintainer**, not an Architect. SWE-bench rewards
exactly the maintainer task — which is why the stack can win it.
