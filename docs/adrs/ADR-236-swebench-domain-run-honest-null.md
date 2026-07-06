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

## 5. The budget gate is removed — a $0 LOCAL endpoint path (2026-07-06)

§4's forward path to *positive compounding* (more generations, more levers, a larger holdout) was blocked on ONE thing: **money.** A hosted cheap model over dozens of instances × generations × agentic steps is real $ + hours, so the flagship run stayed confirm-gated and small. That gate is now removed for anyone with a local OpenAI-compatible server (`ruvllm serve`, or an ollama endpoint at `http://localhost:11434/v1`): the SAME agentic solver and the SAME official-harness gold-scoring, at **$0 inference**.

`d1s4-live-run.mjs` gained `--api-key-env` and a local-no-auth path (`swebench-endpoint.mjs → resolveEndpointAuth`, pure + unit-tested): an `--api-key-env NONE` or a `localhost` `--base-url` is treated as keyless and **$0** — the proposer's spend and the solver's `costUsd` are both zeroed, and the auth header is omitted. So a full positive-compounding run is now:

```
d1s4-live-run.mjs --solver agentic --holdout 25 --generations 4 --targets editPolicy,escalationPolicy,verifierPolicy \
  --base-url http://localhost:11434/v1 --api-key-env NONE --model qwen2.5-coder:32b --proposer qwen2.5-coder:32b
```

Two honesty guards ship with it:
- **Only the official swebench Docker harness gold-scores.** A local model changes the $, never the scoring — the gate, anchor, and signed replay bundle are byte-identical to a hosted run.
- **A local-models pre-flight** (`--plan`, $0 `GET /v1/models`): because the runner shares ONE endpoint for solve *and* propose, a hosted-style `--proposer` (the default `anthropic/claude-sonnet-5`) against a local server would silently yield **zero mutations** — a wasted null run. `--plan` now reports `local models served: BLOCKED` and refuses to launch unless both the solver and proposer models are actually served locally.

**This ADR is still NOT amended to "domain-proven compounding."** Removing the budget gate makes a longer/larger run *cheap to attempt*; it does not manufacture a result. The positive-compounding claim is earned only when a run produces a real, anchor-surviving, replayable lift curve (`milestone_reached=true`) — gold-scored by the official harness, as always. What changed is that attempting it no longer costs money or a confirmation — it is a one-command `$0` launch, and the machine-load of a multi-hour agentic + Docker run is the only remaining reason to run it watched rather than fire-and-forget.

## 6. Structural capability levers — giving the flywheel a REAL knob (2026-07-06)

§4's null and §5's ceiling analysis both point at the same root cause: the D1 policy levers (`editPolicy`,
`escalationPolicy`, `verifierPolicy`) only **append system-prompt prose**. That is the ADR-226
"zero-marginal-advisor" shape — a mutation adds a *hint*, and a weak base model is free to ignore it, so
there is little for a promotion to compound on. A policy that can only talk to the solver cannot change
what the solver *does*.

So the flywheel now gets a **structural** lever, `solverCapabilities`, that evolves WHICH real solver
capabilities are on rather than what the prompt says:

- **`repro-gate`** → `--repro-gate`: write a failing reproduction test first, then iterate the patch against it.
- **`reviewer`** → `--reviewer`: a critic sub-agent reviews the patch and drives a bounded revise loop.

Both hit the *same* chat endpoint, so they stay **$0** on the local endpoint from §5 (unlike `--localize`,
which needs a hosted embedder and is deliberately not on the menu). The lever is wired end-to-end in the
darwin-mode SWE-bench **adapter** — `@metaharness/flywheel` and `meetsPromotionRule` are **untouched**:

1. **Proposer** (`makeSwebenchProposer`): for this lever the model picks a bounded subset from a fixed
   MENU (not free text); the pick is filtered to the menu so the stored policy / lineage stays clean.
2. **Solver-cli** (`makeCliSolver`): the structural lever is split out of the prose levers — it maps to
   allowlisted argv flags (behaviour), never to `SWE_POLICY_SYSTEM` (prose). `''` ⇒ no flags ⇒
   byte-identical to the pre-lever default (backward-safe).
3. **Security**: the lever value is produced by an LLM proposer, so it is **never passed through**.
   `capabilitiesToFlags` keeps only exact allowlist tokens (`repro-gate`, `reviewer`) and maps them to
   known flag strings; anything else (shell metacharacters, hallucinated flags, `--repro-gate` in flag
   form) is dropped — fail-closed. `spawnSync` uses an argv array, so tokens are never shell-interpreted
   even if they slipped through. Input validation at the process boundary.

Tests: `capability-lever.test.mjs` 6/6 (allowlist + dedupe + injection-safety + prose/structural split +
proposer menu); full swebench bench suite 139/139. **This still does not amend the "compounding null"
verdict** — it removes the *reason* the null was over-determined (prose-only levers). Whether the flywheel
now finds a genuine, anchor-surviving structural improvement is an empirical question the $0 local run
(`--targets solverCapabilities`, §5) will answer — gold-scored by the official harness, as always.
