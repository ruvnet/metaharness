# ADR-236: D1 SWE-bench domain flywheel run — an HONEST NULL (mechanism proven, base-solver-limited)

- **Status**: Accepted — D1-S5 evidence. The flywheel MECHANISM is proven end-to-end on REAL SWE-bench; there is NO compounding lift because the base solver is too weak. This is an honest negative, not domain proof.
- **Date**: 2026-07-06
- **Deciders**: ruv
- **Tags**: flywheel, swebench, domain-scale, honest-null, evidence, d1, metaharness
- **Extends**: ADR-233 (evals adapter pattern), ADR-234 (the recovery-not-creation ceiling), ADR-235 (honest-null replay + gate re-execution)
- **Artifacts**: `packages/darwin-mode/bench/swebench/{flywheel-swebench-evaluator,swebench-solver-cli,swebench-grade,d1s4-live-run}.mjs`, the frozen `swebench-holdout-frozen.json` (40) + `swebench-anchor-frozen.json` (15), `proof-bundle-swebench.json` (the LIVE bundle, replay PASS).

---

## 1. What was run

The D1 arc built a SWE-bench code-repair flywheel domain on `@metaharness/flywheel` (S1 evaluator adapter → S2 frozen holdout+anchor → S3 $0 dry-run → S4 budgeted LIVE run). S4 ran `runFlywheelGenerations` over a frozen SWE-bench-Lite holdout (25 instances) with a real cheap-model solver and the **official swebench Docker harness for gold-scoring** — the only thing that produces a real resolved count.

**Two budgeted LIVE runs, both honest nulls:**

| Run | Solver | Root resolved | Compounding lift | Milestone | Replay |
|---|---|---|---|---|---|
| 1 | `z-ai/glm-5.2` | **1/25** | none (0 promotions) | false | (failed pre-ADR-235; now PASS) |
| 2 | `deepseek/deepseek-chat` | **1/25** | none (0 promotions) | false | **PASS** |

Both spent ~$0.01–0.014 (properly tracked after the ADR-`usage:{include:true}` fix) and produced a **root-only lineage** (0 verified improvements, `milestone_reached=false`). The replay bundle verifies (`verifyReplayBundle.pass=true`), including the ADR-235 **gate re-execution** (every — here, zero — promoted commit re-passes `meetsPromotionRule` on its sealed scores).

## 2. The honest verdict

**Proven (do claim):** the flywheel MECHANISM works end-to-end on REAL SWE-bench code-repair — adapter → real cheap solver → **official Docker gold-scoring** → frozen `meetsPromotionRule` gate → signed lineage → a replay bundle an external reviewer can verify (receipts + reachable root + gate fingerprint + gate re-execution). No step is synthetic; no number is fabricated.

**NOT proven (do NOT claim):** that policy evolution *compounds* on code-repair. There was **no lift** because the base solver has **no headroom**: `solve.mjs` is an **open-loop single-shot** shim with a high empty-patch rate, and it resolves ~1/25 on SWE-bench-Lite **regardless of the model** (glm-5.2 and deepseek-chat both landed 1/25). A single lucky resolve out of 25 gives the flywheel nothing to mutate toward.

This is exactly the ADR-234 ceiling made concrete: **the flywheel recovers preventable loss; it cannot create capability the base solver lacks.** When the base resolves ~4% with near-zero variance, there is no preventable-loss signal for a policy mutation to capture — so the gate (correctly, UNCHANGED) promotes nothing, and the honest outcome is a flat root-only lineage.

## 3. Consequences

- **D1 is closed as an honest null, not a proof.** The "reasoning-proxy" caveat is *narrowed* (the harness demonstrably runs on real SWE-bench with real gold-scoring) but **not removed** (no code-repair compounding shown). Reported plainly, per the frozen-gate discipline.
- **Two real bugs were surfaced + fixed by running this honestly** (documented in ADR-235 + the cost-tracking fix): `verifyReplayBundle` failing on a valid 0-promotion run, and the budget guard reading $0 because `usage.cost` needs `usage:{include:true}`. Honest negatives improve the harness.
- **Forward path to a positive result:** swap the single-shot `solve.mjs` for the **agentic solver** (`solve-agentic.mjs`, multi-shot with local test feedback in the Docker env) or a capable model with a repair loop, so the base resolves enough (≥5–8/25) to give the flywheel headroom. Only then can a code-repair compounding curve be honestly claimed — and it would still ship a signed, gate-re-executable replay bundle.
- **Forward path is now WIRED (no code left to write before the run).** The agentic solver was inert to the flywheel because it did not read the `SWE_POLICY_SYSTEM` seam — so a policy mutation could not change how it operates, and it would reproduce this null. Fixed: the seam is now a single shared, unit-tested helper (`agentic-loop.mjs → applyPolicySystem`) used by BOTH `solve.mjs` and `solve-agentic.mjs`, and the runner takes `--solver single|agentic` (`d1s4-live-run.mjs`; agentic passes `--max-steps`/`--concurrency`). The positive-path run is therefore a one-flag, budget-confirmed launch: `d1s4-live-run.mjs --solver agentic --holdout 25 …`. It remains DEFERRED until a budget is confirmed (real $ + Docker hours); this ADR is not amended to "domain-proven" until that run produces a real, replayable compounding curve.
- **The run is now crash-recoverable.** An agentic run spans HOURS, and the prior single-shot run crashed at ~45min losing everything. `@metaharness/flywheel` (0.1.4) now takes an optional `onGeneration` checkpoint hook — a complete, independently replay-verifiable bundle for the run so far, emitted after each generation (observation-only; a throwing hook can't abort a valid run). `d1s4-live-run.mjs` persists it to `proof-bundle-swebench.partial.json` each generation, so a crash keeps the completed generations' evidence. **And it can now RESUME** (`@metaharness/flywheel` 0.1.5): the checkpoint carries a `resumeState`, and `d1s4-live-run.mjs --resume` continues from `fromGeneration + 1` (re-seeding the lineage, restoring the promoted policy + spend) instead of re-spending from generation 1 — a resumed run is proven byte-identical to an uninterrupted one (same commit ids, policy, lift curve).
- **This ADR also wires ADR-235's gate re-execution into the callers** (`d1s4-live-run.mjs` + the HLE adapter test now pass `promotionRule` to `verifyReplayBundle`), so every future run's replay is forgery-proof, not just fingerprint-checked. `meetsPromotionRule` UNCHANGED.

## 4. The AGENTIC positive-path run (2026-07-06) — MECHANISM-PROVEN, compounding still NULL (with an anti-Goodhart save)

The forward-path run was executed for real (user-authorized): `d1s4-live-run.mjs --solver agentic --holdout 25 --anchor 3 --generations 2 --budget 15 --model z-ai/glm-5.2 --proposer anthropic/claude-sonnet-5`. Gold-scored by the OFFICIAL swebench Docker harness. Spend $0.0086 (tracked; well under the $15 cap). Signed replay bundle committed (`proof-bundle-swebench.json`, `data_source: LIVE`) + `analyze-swebench.json`.

| Metric | Single-shot (§1, prior) | **Agentic (this run)** |
|---|---|---|
| Base (gen-0 root) resolved | 1/25 | **3/25 (12%)** — a real 3× base lift |
| Verified improvements | 0 | 0 |
| Anchor-surviving promotions | 0 | 0 |
| milestone_reached | false | false |
| Replay (incl. `gateReExecutes`) | PASS | **PASS** |

**What this proves (honestly):**
- **The multi-shot agentic solver genuinely lifts base code-repair capability** (1/25 → 3/25), gold-scored by the official harness — not a proxy.
- **The full domain mechanism is proven end-to-end on REAL SWE-bench:** agentic solve → official gold-score → frozen-gate flywheel → signed, externally-replayable, gate-re-executing bundle. Every replay check passes.
- **The anti-Goodhart guard actively fired:** of the 2 candidate policies proposed over 2 generations, one *improved the holdout* (best Δ +1 on `editPolicy`) but **regressed the frozen anchor** — so the gate **rejected it** (`anchor-regressed=1` in `analyze-swebench.json`). The anchor suite did exactly its job: it refused a holdout-overfit.

**What this does NOT prove (the honest limit):** **compounding is still NULL** — 0 promotions over 2 generations, `milestone_reached=false`. A short 2-generation run with a single mutation lever (`editPolicy`) found no *genuine* policy improvement that survived the anchor. So this ADR is amended to **MECHANISM-PROVEN on real SWE-bench with a demonstrated anti-Goodhart rejection, but compounding-null** — NOT "domain-proven compounding." Removing the "reasoning-proxy" caveat is earned (the mechanism ran on real code-repair, gold-scored); claiming compounding lift is NOT. Forward path to a *positive compounding* result: more generations, more/other mutation levers (`escalationPolicy`, `verifierPolicy`), and a base with more headroom (3/25 leaves little room for a policy to compound on 25 instances) — e.g. a larger holdout so the gate's noise floor is lower.
