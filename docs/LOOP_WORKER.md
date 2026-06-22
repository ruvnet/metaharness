# Darwin Mode — autonomous loop worker directive

Versioned source of truth for the cron/`/loop` worker. **Cadence: every 5 min until complete.**
Updated 2026-06-22 for the **ADR-173 leaderboard-conformant phase**.

## Active goal (ADR-173): a LEGITIMATE top-10 on SWE-bench Lite → then Verified
Our 68.3% used the gold `FAIL_TO_PASS` as an in-loop oracle → **not submittable**. Drive a conformant,
cost-per-resolve-optimal entry to a real placement. **Completion = a conformant batch clears the phase
threshold AND is submitted (or no lever fits remaining budget).**

| phase | target | how | done? |
|---|---|---|---|
| L0 | conformant solver | `solve-agentic --no-test-oracle` + leakage guard | ✅ shipped |
| L0.5 | strong conformant signal | run repo's OWN tests in the instance Docker image (no gold patch) | pending |
| L1 | **Lite top-10 (≥45%)** | conformant MiniMax-M2.5, full-300, 1 attempt, `--max-cost` | pending |
| L2 | **Lite #1 (>60.33%)** | + PTY loop (ADR-170) + conformant best-of-N | pending |
| V1 | **Verified top-10 (~70%)** | same stack on Verified-500 | pending |

Model = cost-per-resolve frontier (leaderboard data): **MiniMax M2.5** (75.8% Verified @ ~$0.07/inst),
DeepSeek V3.2 ($0.23/$0.34 — cheapest reasoning), Kimi K2.5. NOT Opus (10× cost). All verified on OpenRouter.

## SOTA odds — report EVERY tick, recompute when a batch lands
First-order model: overall-resolve ≈ **patch-attempt-rate × conditional-resolve**. Measured floor
(DeepSeek-only k=5, Lite-25): 0.44 × 0.45 ≈ **20.0%**. The 45% conditional-resolve is a *separate
ceiling* — filling empty patches alone caps ~45%; reaching 70%+ needs conditional-resolve to rise too.

| target | threshold | odds (2026-06-22, post MiniMax-swap **falsified**) |
|---|---|---|
| **Pareto cost crown** (competitive resolve at lowest $) | — | **~30–45%** ↓ — only if the applicator fix lifts resolve to ~40%+; a cheap 20% system is *dominated*, not a crown |
| **Top-10 Lite** | ≥45% | **~20–30%** ↓ — needs the applicator fix AND k=10/sniper |
| **#1 Lite** | >60.33% | **~8–12%** ↓ |
| **Absolute SOTA** | ~80–85% | **<5%** ↓ |

**Two conformant batches both = 5/25 = 20.0%.** Model swap (DeepSeek→MiniMax-M2.7 for patches) moved
nothing → bottleneck is the **structural empty-patch applier** (~50% empty both models) + a ~42–45%
conditional-resolve ceiling. Next input = the **robust-patch-applicator** experiment, not a bigger model.
Recompute from each batch; only measured numbers move the odds.

## Tracking issues (reply EVERY tick with details)
- **#45 — SWE-bench Lite** conformant run · **#46 — SWE-bench Verified** conformant run.
- Each tick that touches a run, post a **detailed comment** to its issue: done/total, submit-rate,
  $/instance + cumulative $, proc liveness, any batch number + Wilson CI, next action. Keep #39 + gist
  current too. Real measured numbers only.

## Each 5-min tick
1. **HEALTH** — prune docker + `/tmp/sbrepo-*` >30min; `docker kill` sweb.eval >12min (requests-2317 hangs); warn disk<50G/RAM<10G.
2. **RUN** — if a conformant solve/eval is in flight, check it + **reply to #45/#46 with the numbers**; on completion → official batch eval → resolve-rate + Wilson CI + **assert `leaderboardConformant:true`** → commit RESULTS + post to the issue. Only batch numbers are authoritative.
3. **ADVANCE** — pilot → full-300 → next phase, each gated on the prior batch clearing its threshold. Every paid run carries `--max-cost` (in-solver cap; never an external watchdog — $2.64 overage lesson).
4. **UPKEEP** — branch+main sync; #39 + gist + README current; publish darwin when a *conformant* number materially changes the story.
5. **SUBMIT** — once a conformant batch clears a threshold: package predictions + trajectories + metadata, PR to `swe-bench/experiments`; link in #45/#46.

## Stop / complete condition
Stop when (a) a conformant top-10 (Lite, then Verified) is achieved + submitted, OR (b) no resolve-rate
lever fits the remaining budget. Then idle on health + upkeep. ONLY real measured numbers + CIs, never fabricate.

See `docs/adrs/ADR-173-leaderboard-conformant-top10.md` (plan) · ADR-170 (PTY) · ADR-172 (SOTA roadmap).
