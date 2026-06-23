# Darwin Mode — autonomous loop worker directive

Versioned source of truth for the cron/`/loop` worker. **Cadence: every 10 min, CONCURRENT workflow, until SOTA.**
Updated 2026-06-22 for the **ADR-176 SWE-Conductor ablation phase** (overnight autonomous).

**Budget: $1000 SOTA (raised from $500, 2026-06-22).** Track real spend vs the session baseline; with
$1000 the Opus-coder arm + full-300 runs are affordable. Still `--max-cost` every paid run; never an
external watchdog.

## STATUS 2026-06-23: SOTA push CLOSED → PRODUCT PIVOT (ADR-177 Option 3 chosen)
Decision locked: **ship the dual-mode product with Test-Driven Repair (68.3% with-test) as the hero**;
the conformant ablation (cheap 12-16% / frontier 33%, scaffold-capped — no top-10 lever) is banked as a
transparent research appendix. SOTA loops idled; **no new paid SWE-bench arms** (a full-300 conformant
run or a mini-SWE-agent-v2 rewrite would need explicit re-authorization). Each tick now: **health +
upkeep + product polish** (README/marketing on TDR, npm publish on material README changes, issue triage).
Ablation conclusions: ADR-173–177, LEARNINGS §10-12, #45.

## (ARCHIVED) CONCURRENT ABLATION WORKFLOW
Keep MULTIPLE conformant MCTS arms in flight at once (container-reuse bounds Docker load; box handled
3 arms at load <1). Each arm = `solve-mcts.mjs` with a model combo. On each arm completion → gold batch
eval → resolved/25 + Wilson CI → record. When a round's arms finish, **read the 2×2, pick the winner,
launch the next round** — autonomously, no waiting for the human.

**The 2×2 ablation (in flight 2026-06-22):** critic ∈ {DeepSeek-V4-Flash, Opus-4.8} × coder ∈
{DeepSeek-V4-Flash, qwen3-coder-30b}. A=DS+DS=12% (done). A′=Opus+DS, B=Opus+qwen, C=DS+qwen (running).
Reads: oracle binds if Opus-critic rows beat DS-critic rows; coder binds if qwen rows beat DS rows.

**Decision tree (execute the winning lever each round):**
- If a combo clears ~25%+ on 25 → scale it to a fresh 50-instance pilot, then full-300.
- If oracle binds (Opus-critic lifts) but coder is the cap → swap coder up the ladder: qwen3-coder →
  minimax-m2.5 ($0.15/$0.90) → claude-haiku-4.5 → Opus-coder sniper on the residual tail only.
- If nothing clears ~25% → the residual is reasoning-bound; run the **Opus-sniper on repro-valid-but-
  unsolved** instances (asymmetric, the tail only) and measure the hybrid ceiling.
- Stop when a conformant full-300 batch hits ≥45% (top-10) — then package trajs/ + metadata.yaml + submit
  PR to swe-bench/experiments. Or when the fresh $500 is exhausted / no lever moves resolve (then write
  the architecture-exhausted ADR + idle on health/upkeep).

Levers queue (SOTA_HORIZON.md): L1 Opus-sniper · L2 plan-then-edit · L3 SBFL localization ($0) ·
best-of-N voting · regression-test selection. Pick highest lift-per-$ each round.

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
1. **HEALTH** — prune docker + `/tmp/sbrepo-*` >30min; `docker kill` sweb.eval >12min **but `grep -v 'sleep infinity'`** (requests-2317 hangs) — the ADR-176 container-reuse holders run `sleep infinity` for the WHOLE instance (up to ~19min on hard Opus-critic instances); killing them mid-instance breaks the repro checks. Only kill genuine eval/test hangs, never reuse holders. Warn disk<50G/RAM<10G.
2. **RUN** — if a conformant solve/eval is in flight, check it + **reply to #45/#46 with the numbers**; on completion → official batch eval → resolve-rate + Wilson CI + **assert `leaderboardConformant:true`** → commit RESULTS + post to the issue. Only batch numbers are authoritative.
3. **ADVANCE** — pilot → full-300 → next phase, each gated on the prior batch clearing its threshold. Every paid run carries `--max-cost` (in-solver cap; never an external watchdog — $2.64 overage lesson).
4. **UPKEEP** — branch+main sync; #39 + gist + README current; publish darwin when a *conformant* number materially changes the story.
5. **SUBMIT** — once a conformant batch clears a threshold: package predictions + trajectories + metadata, PR to `swe-bench/experiments`; link in #45/#46.

## Stop / complete condition
Stop when (a) a conformant top-10 (Lite, then Verified) is achieved + submitted, OR (b) no resolve-rate
lever fits the remaining budget. Then idle on health + upkeep. ONLY real measured numbers + CIs, never fabricate.

See `docs/adrs/ADR-173-leaderboard-conformant-top10.md` (plan) · ADR-170 (PTY) · ADR-172 (SOTA roadmap).
