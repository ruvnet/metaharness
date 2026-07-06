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
- **This ADR also wires ADR-235's gate re-execution into the callers** (`d1s4-live-run.mjs` + the HLE adapter test now pass `promotionRule` to `verifyReplayBundle`), so every future run's replay is forgery-proof, not just fingerprint-checked. `meetsPromotionRule` UNCHANGED.
