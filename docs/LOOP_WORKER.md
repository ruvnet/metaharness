# Darwin Mode — autonomous loop worker directive

Versioned source of truth for the cron/`/loop` worker. **Cadence: self-paced, until SOTA or budget.**

## ▶ CURRENT DIRECTIVE (2026-06-23): 12h SOTA push + orthogonal routing

**Budget cap: $800 cumulative OpenRouter spend** (leaves $200 buffer; abort all provisions if `curSpend() > 800`).
**vCPU quota 32 (us-central1-a). Empirical only — NO SOTA claims on n=25; n=300 is the only verdict. Zero idle VMs.**

- **Phase 1 — monitor & record** the running fleet → log full-300 verdicts (`glm-5.2`, `deepseek-v3.2`) vs the
  champion (DeepSeek-V4 Best-of-3 **39.7% @ $0.015**) on the Value Score; log the opus n=25 ceiling + minimax/nemotron.
- **Phase 2 — cross-model Best-of-N** (DONE): runner `MODE=xbo` + genome `mode:'xbo'` (model = comma-list of
  DIFFERENT models), costModel sums, mockResolve union-bonus, LLM-mutation mixes orthogonal models. `provexbo <csv>`.
- **Phase 3 — orthogonal prove-25**: `provexbo deepseek/deepseek-v4-flash,z-ai/glm-5.2,moonshotai/kimi-k2.6`
  (open-weight orthogonal bo3) + `provexbo deepseek/deepseek-v3.2,z-ai/glm-5.2` (ultra-cheap bo2). `--no-address` + NAT,
  aggressive `cleanupDone()`. Does orthogonality beat the 45% single-model union ceiling?
- **Phase 4 — autotune + SOTA lock**: `node scripts/gcp-cluster.mjs autotune 3 0.7` → highest-Value champion →
  ONE full-300 confirmation → if it beats 39.7% @ $0.015, codify it as the metaharness default (data-driven).
- **Guards (CRITICAL)**: spend>$800 → abort; `cleanupDone()`/`down all` on any crash; each tick check spend +
  `rank`. Final deliverable: a markdown table comparing the starting SOTA (39.7% @ $0.015) to the new SOTA.

Each loop tick: HEALTH (prune, kill >12min hangs) → check `rank` + fleet → advance the current phase → commit
artifacts → report. The fleet is self-managing (AUTOSTOP + controller auto-delete); never leave VMs billing idle.

### Tick discipline (added 2026-06-23 — the run is mostly GCP-idle)
- **Idle tick** (no new `rank` row, no phase change, spend flat): emit **ONE line** — `spend $X/$800 · N VMs · waiting on <what>`.
  Do NOT re-explain the standings or re-derive analysis every heartbeat. Substantive output only when something lands.
- **A verdict lands** (new n=25 or n=300 row): record it (LEARNINGS if material), commit, and report the delta only.
- **Phase-4 trigger** (explicit): when the **xbo** results AND **≥1 full-300 verdict** (glm-5.2 or deepseek-v3.2) are in
  Firestore → run `node scripts/gcp-cluster.mjs autotune 3 0.7` ONCE (guarded), then promote the highest-Value
  genome to ONE full-300 confirm. Codify the metaharness default ONLY if that full-300 beats 39.7% @ $0.015 on Value.
- **Report the champion across `w`, not one `w`.** w=0.7 (capability-leaning) is for SOTA hunting; the honest
  deliverable is the cost-Pareto *frontier* (which config wins at each w), not a single "the SOTA" cherry-picked at one w.
- **Spend guard every tick**: `curSpend() > 800` → abort all provisions + `down all`. n=300 is the only verdict — never claim on n=25.
- **PUSH TO BOTH `branch` AND `main` every commit** — the GCP VMs `git clone -b claude/darwin-mode-evolve-polyglot`,
  so a `main`-only push leaves every VM on **stale code**. (This bit hard: the branch sat at `9811414` a whole
  session → VMs lacked `discriminator.mjs` (bo3/xbo crashed) + the `curl -f` fix (full-300 crashed). Always
  `git push origin HEAD:claude/darwin-mode-evolve-polyglot && git push origin HEAD:main`.)

---

Updated 2026-06-22 for the **ADR-176 SWE-Conductor ablation phase** (overnight autonomous).

**Budget: $1000 SOTA (raised from $500, 2026-06-22).** Track real spend vs the session baseline; with
$1000 the Opus-coder arm + full-300 runs are affordable. Still `--max-cost` every paid run; never an
external watchdog.

## STATUS 2026-06-23: PROVEN ARCHITECTURE → confirm cost-Pareto SOTA at full-300 (SERIALIZED)
The interactive ReAct loop (`solve-agentic.mjs --no-test-oracle`; `run_tests` = repo's OWN tests in Docker,
conformant) broke the MCTS Goodhart trap. **Measured (25-pilot, gold, conformant):** single-traj 36-52%,
union-of-3 **60%** ceiling, **Best-of-3 + env-filter + LLM-judge = 13/25 = 52% @ ~$0.015/inst** (87% union
capture). Strong cost-Pareto-SOTA signal — but n=25 CIs are wide. **The job now is the FULL-300 confirmation.**

### ⚠️ HARD OPS RULES (learned the hard way 2026-06-23 — a load-180 incident)
1. **SERIALIZE.** At most ONE full-300 generation AND at most ONE gold eval running at a time. Never 3
   concurrent full-300 + eval — it caused a git-clone storm + an 800%-CPU sklearn-pytest storm → load 180.
2. **Total concurrent git clones ≤ 3** (the GitHub-rate-limit cap; `--concurrency 2-3`, never stack runs).
3. **env-filter / run_tests must target the SPECIFIC changed test file** (`-x`, capped), NEVER a whole
   package suite — `sklearn/tests` etc. spawn multi-hundred-%-CPU pytest. (Fix in discriminator.mjs + solve-agentic existingTestTargets before re-running.)
4. **Orphaned containers outlive killed host procs** — after killing any run, `docker ps -q | xargs docker kill`.
5. **MULTI-SESSION SAFETY:** another Claude session may share this box (seen 2026-06-23: foreign ppid running
   mm25-* runs). **NEVER mass-`pkill -f` by pattern** — it kills the other session's work. Check `ps -o ppid`
   and only kill procs whose ancestry is THIS session's run_in_background tasks.

### Serialized path to the confirmed number
1. Fix the env-filter (rule 3). Re-run **Set A gold eval ALONE** → firm full-300 single-traj base rate.
2. Complete **B/C tails** (200→300) one at a time → full-300 Best-of-3.
3. Run discriminator (env-filter + judge) on the 3 full-300 sets → gold + union → the **submittable number**.
4. **Models:** DeepSeek-V4-Flash (proven cheap coder); MiniMax-M2.5 is the higher-tier ceiling test (pilot first).
- **Goal (RECALIBRATED 2026-06-23):** the defensible claim is the **cost-Pareto frontier** — highest
  resolve-per-dollar — NOT absolute top-10. Our ADR-173 board snapshot (#1=60.33%, top-10≈45%) is likely
  STALE: by mid-2026 the Lite board may have inflated (frontier 70%+, GPT-5-Mini ~56%), so 52% is ~rank-15
  absolute, but cheapest-per-resolve by a wide margin (52% @ $0.015 vs others' $0.05-$50). **Re-fetch the
  live leaderboard before ANY placement claim.** Pipeline result (pilot): Best-of-3 interactive + env-filter
  + LLM-judge = 13/25=52% [33.5,70] @ $0.015/inst (LEARNINGS §15-16). Full-300 confirming. Only batch
  numbers; never claim a rank we haven't verified against the live board.

## (SUPERSEDED) STATUS: SOTA push CLOSED → PRODUCT PIVOT (ADR-177 Option 3 chosen)
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
