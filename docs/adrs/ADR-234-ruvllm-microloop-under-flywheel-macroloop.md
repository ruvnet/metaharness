# ADR-234: Two-layer learning — ruvllm micro-loop (SONA/MicroLoRA/EWC++) under the flywheel macro-loop auditor

- **Status**: Accepted — with evidence. `@metaharness/evals-servedmodel@0.1.0` (tracking issue [ruvnet/metaharness#109]) proves the full ruvllm-policy → frozen-gate → signed-replay-bundle pipeline END-TO-END on a $0 SYNTHETIC fixture (12/12 tests green, replay `gateReExecutes: true`). The COMBINED real-served-model lift claim (§5's acceptance test on an actually-loaded, actually-served model) remains an explicit, honest **DEFERRED / null** — no model was loaded or served this session either; see §7.
- **Date**: 2026-07-05 (updated 2026-07-06 — §7, Track #1 closure)
- **Deciders**: ruv
- **Tags**: ruvllm, ruvector, flywheel, microlora, sona, ewc, catastrophic-forgetting, two-layer-learning, local-inference, promotion-gate, metaharness
- **Extends**: the `@metaharness/flywheel` engine (frozen `meetsPromotionRule`, anchor suite, signed receipts, replay bundles), [[ADR-233]] (HLE policy-evolution adapter — the answer-production policy the macro-loop tunes)
- **Verified this session (by execution, not help text)**: `ruvllm_status`, `ruvllm_microlora_create` + `ruvllm_microlora_adapt`, `ruvllm_sona_create` + `ruvllm_sona_adapt`.
- **Verified 2026-07-06 (by execution — the adapter package, not the MCP surface)**: `@metaharness/evals-servedmodel`'s full `runFlywheelGenerations` loop on a deterministic synthetic fixture; see §7 for numbers.

---

## 1. Context

The flywheel (`@metaharness/flywheel`) optimizes the **scaffolding around a static engine**: it freezes the model and evolves the harness policy, promoting only what proves lift on a frozen holdout. It treats the model as a black box.

An adaptive serving runtime — **ruvllm** (with **ruvector** memory) — changes that assumption. ruvllm runs a **SONA** (Self-Optimizing Neural Architecture) loop on local hardware: per-request **MicroLoRA** weight adjustments (ranks 1–4), HNSW-indexed memory routing, and **EWC++** (Elastic Weight Consolidation) to resist drift. Where the flywheel is a **macro-loop** (structural, auditable, holdout-gated), ruvllm is a **micro-loop** (real-time, per-request, weight-level).

The thesis under test: layering them builds a **two-tier optimization engine** — a self-improving *system* loop over a self-optimizing *inference* loop. This ADR records what that architecture is, **what we verified**, and — critically — the honest boundary between the two.

### 1.1 What we verified this session (measured, not asserted)

Running the ruvllm MCP surface directly:

- **`ruvllm_status`** → native coordinator `active`, `trainingBackend: "ruvllm"`, contrastive trainer active, graph backend active; wasm available (not yet initialized).
- **MicroLoRA** (`create` rank 2, 384→384; `adapt` with quality feedback) → returns a **real LoRA adapter**: `lora_a`/`lora_b` matrices (768×768 internal), `scaling 0.5`, `rank 2`, gradient buffers, and running counters — `samples_seen` 1→2 and `quality_sum` 0.9→1.2 across two quality-weighted adaptations. The weights are real state, not a stub.
- **SONA** (`create` hidden 64 / capacity 128; `adapt` with quality) → config carries **`ewc_lambda: 0.1`** (the EWC++ forgetting guard the thesis names), `ema_decay 0.95`, `quality_threshold 0.5`; `quality_ema` moved 0.5→0.5175 on a positive signal. The catastrophic-forgetting machinery exists on the weights side.

These primitives are genuine. That is the floor this ADR builds on — and the ceiling of what is *proven*: we exercised the **adaptation primitives**, not a served local model doing MicroLoRA-during-inference end-to-end (no model was loaded; wasm uninitialized).

## 2. Decision

Adopt the **two-layer** composition, with the flywheel as the **programmatic fail-safe** over ruvllm's live adaptation:

- **Micro-loop (ruvllm):** per-request SONA/MicroLoRA weight adaptation + ruvector memory routing. Fast, local, sub-cent, adapts the model's behaviour to the live interaction.
- **Macro-loop (flywheel):** the structural auditor. It treats a *candidate ruvllm adaptation* (a promoted MicroLoRA/SONA state distilled from interaction history) as a **policy candidate** and runs it through the **frozen `meetsPromotionRule`** on the private holdout + the frozen **anchor** suite, emitting a signed, replayable receipt. **No ruvllm adaptation reaches production until the flywheel gate admits it.**

The load-bearing rule (unchanged from the rest of the series): **the flywheel gate is frozen and the anchor suite is never optimized against.** ruvllm proposes; the flywheel disposes.

## 3. Safeguarding against catastrophic forgetting (two independent guards)

Any model that learns from live interactions can drift — slowly catering to recent conversation paths and *forgetting* core reasoning (a real bottleneck on hard exams like HLE, [[ADR-233]]). We defend at two levels:

1. **Weights-level (ruvllm):** EWC++ (`ewc_lambda`) penalizes moving parameters important to prior tasks — verified present in the SONA config.
2. **Programmatic fail-safe (flywheel):** before an adaptation is promoted, it must **not regress the frozen anchor suite** (the retained-capability check) and must clear the frozen conjunctive gate; the decision is Ed25519-signed and replayable. This guarantees the adaptive system is measurably *getting smarter*, not just fitting recent chats — and if EWC++ ever fails silently, the anchor clause catches it.

The anchor suite is exactly the "did it forget?" oracle: a MicroLoRA that improves the live task but drops the anchor is rejected as a Goodhart/forgetting regression.

## 4. Consequences

- **A dynamic engine under dynamic scaffolding.** Standard flywheel bends the *policy* around a static model; dropping ruvllm into the core lets the *weights* bend too — with the flywheel's frozen gate as the trust boundary that keeps live weight-adaptation honest.
- **Latency stays low.** ruvllm's Rust/SIMD memory search + routing run in a few ms, so the heavy flywheel evaluation can run in the background without stalling the interactive path.
- **Clear proven/unproven line (do not overclaim):**
  - **PROVEN:** ruvllm adaptation primitives (MicroLoRA weights, SONA + EWC++) are real and respond to quality feedback; the flywheel gate + anchor discipline are real ([[ADR-233]], `@metaharness/flywheel`).
  - **DESIGN CLAIM (unproven):** that this composition yields net capability lift on a real benchmark. That must clear the **same holdout gate** — a promoted ruvllm adaptation beating baseline on private validation, preserving the anchor, confirmed once on a frozen holdout, signed. Until then it is architecture, not a result. In particular, the "most advanced local setup" verdict is a hypothesis this ADR makes *testable*, not a measured finding.
- **Next experiment (to move it from claim to result):** serve a local model via ruvllm (initialize wasm / load a GGUF), run a task stream, distill the SONA/MicroLoRA adaptation into a flywheel policy candidate, and gate it exactly like the HLE/SWE-bench adapters — emitting a signed replay bundle. Concretely reuses the ADR-233 four-set contract + frozen anchor.

## 5. Realistic ceiling — error recovery, not intelligence creation

The two-layer system is **error recovery, not intelligence creation.** It cannot manufacture knowledge, reasoning depth, or world-model capacity the base model and its data never contained. A working capability model:

```
final capability = base capability
                 + recovered preventable errors
                 + domain-adaptation gain
                 + routing/verification gain
                 − drift − overfit − latency − cost penalties
```

**Realistic gains by where the failure lives** (the closer to policy/routing/memory/formatting/verification, the bigger; the closer to missing pretraining/reasoning, the smaller):

| Task type | Expected lift | Why |
|---|---|---|
| General open-ended reasoning | **+1–5 pp** | most errors are true capability gaps, not policy mistakes |
| HLE-style expert QA | **+4–10 pp** | if adapters + subject policy + normalization + verification + promotion all work; >+10 is suspicious without a frozen holdout |
| Narrow enterprise domain | **+10–30 pp** | latent ability present but missing company memory/terminology/formats/workflow |
| Agentic coding / ops | **+20–60 pp** | when failures are harness-bound (tool order, retry policy, context packing, acceptance checks, routing) |
| Local small-model usability | **2×–5× apparent usefulness** | the system stops wasting limited competence — not "5× smarter" |

Framed as **headroom recovery**: broad benchmark → recover ~5–15% of current errors; narrow domain → ~20–50%; harness-bound agents → ~30–70%. *(Example: 40% on a domain task with a 75% ceiling = 35 pp headroom; recovering 30–50% ≈ +10–18 pp. The same system on a 52% HLE model with a ~60% class ceiling might add only +3–6 pp.)*

**Six hard limits set the ceiling:** (1) base-model latent capability — LoRA steers/specializes, it does not make a weak base frontier; (2) adapter capacity — a rank-2 adapter shapes style/routing/local correction, not whole new disciplines; (3) feedback quality — the flywheel only improves what it can measure, and a noisy/exploitable/public-benchmark-adjacent reward overfits; (4) stability vs plasticity — EWC++ reduces forgetting but the tradeoff remains (too much plasticity drifts, too much stability stops learning); (5) information availability — adaptation cannot invent facts/tools/proofs absent from memory/retrieval/environment; (6) evaluation ceiling — tasks needing new architecture/pretraining/data/test-time-compute plateau (scaling laws mean serving-side adaptation cannot erase the gap to a much stronger pretrained model).

**The warning label is our own [[ADR-226]]:** a strong read-only advisor added **3/19 vs 3/19 — zero marginal resolves at 5.4× cost.** The winning lever was not advice; it was **evolving the executor policy and promoting only proven changes.** Assume no improvement loop helps until the gate says it did.

**Best claim:** ruvllm + flywheel can make a model *dramatically* better at a measured workflow, *modestly* better at general intelligence.

**Acceptance test (frozen 500-task holdout):** run three arms — **adapter off** vs **adapter on** vs **adapter + flywheel on**. Count it real only if it clears **at least one** of: **+≥3 pp accuracy**, **−≥25% cost per correct**, or **−≥50% regression rate** — **with no anchor degradation.** This is the same holdout/anchor discipline as the HLE ([[ADR-233]]) and SWE-bench adapters; a promotion that clears it ships a signed replay bundle.

## 6. Notes

This ADR was authored **concurrently** with a live budgeted SWE-bench flywheel run (D1-S4) — the macro-loop exercising a real gold-scored holdout while the micro-loop primitives were verified. The two loops are independent by design; that they can run at once is the point.

## 7. Track #1 closure (2026-07-06) — the served-model → flywheel pipeline, end-to-end, on synthetic data

Tracking issue: [ruvnet/metaharness#109]. This closes the specific gap §1.1 and §4 named: "we exercised the adaptation primitives, not a served local model doing MicroLoRA-during-inference end-to-end." It does **not** close the gap by loading a real model — it closes it by building and proving, on a deterministic $0 fixture, the exact pipeline a real run would use, so that a future real run only has to swap the SolveFn, not invent new machinery.

### 7.1 What was built — `@metaharness/evals-servedmodel@0.1.0`

Mirrors `@metaharness/evals-hle`'s adapter shape exactly (typed genome → evaluator → composite gate → $0 synthetic test), applied to the ruvllm serving policy instead of an answer-production policy:

- **`ServedModelPolicyGenome`** (`src/genome.ts`) — every lever a bounded enum or clamped number, never free text: `microloraRank` [1,4], `ewcLambda` [0,1], `emaDecay` [0,1], `qualityThreshold` [0,1], `routingDepth` [1,8], `adaptationMode` (off/conservative/balanced/aggressive), `memoryRoutingMode`, `distillationTrigger`, `minSamplesForDistillation`. The gen-0 root is pinned to the exact values §1.1 verified live (rank 2, `ewcLambda` 0.1, `emaDecay` 0.95, `qualityThreshold` 0.5) — not guessed.
- **`makeServedModelEvaluator`** (`src/evaluator.ts`) — the `ServedModelSolveFn` seam projects a served model's per-task behaviour under a genome onto a `ServedModelScore` (mean adapted quality, cost per adapted win, p50 latency, no-commit rate, **retained-'core'-capability quality**, structural drift-risk flag).
- **`distillPolicyFromState`** (`src/state.ts`) — the pure, deterministic function this ADR's §4 "next experiment" asked for: a promoted MicroLoRA/SONA state summary (rank, scaling, samples_seen, quality_sum, weight magnitude; EWC/EMA/quality-threshold config, quality_ema) → a genome candidate the flywheel can gate. Gated on `samples_seen` eligibility (`checkDistillationEligibility`) before distillation is even attempted — a low-sample state is noise, not signal.
- **`detectDriftRisk` / `driftRisky`** (`src/driftguard.ts`) — the STRUCTURAL half of §3's "two independent guards": a genome-only, data-free scan that fails closed on `aggressive` mode + sub-floor `ewcLambda`, or max routing depth with no forgetting guard at all. This is checked *before* any suite is even scored — defense in depth ahead of the measured anchor check.
- **`servedModelPromotionRule`** (`src/gate.ts`) — calls `meetsPromotionRule` **VERBATIM**, unchanged, then ANDs: the structural drift-risk flag, a retained-capability tolerance on 'core'-item quality, a commit-rate-must-not-worsen clause, and a latency-growth cap. `gateFingerprint(servedModelPromotionRule) !== gateFingerprint(meetsPromotionRule)` — proven a strict superset, not an edit.
- **`ruvllmClient.ts`** — a REAL, network-calling `ServedModelSolveFn` against a live `ruvllm serve` endpoint (same OpenAI-compatible contract as `packages/darwin-mode/src/ruvllm-mutator.ts`), gated: it **throws** unless `live: true` / `EVALS_SERVEDMODEL_LIVE=true` is explicitly set, so a caller can never silently get synthetic numbers mislabeled as live. This file is wired but **not exercised** — see §7.3.

### 7.2 Proven (measured, by execution — `npm test` in `packages/evals-servedmodel`, 12/12 green)

- **Compounding, replayable lift on the $0 synthetic fixture** (400 synthetic tasks, 1/3 tagged `'core'` = retained-capability items the anchor suite draws from): root holdout `primary` 0.3404 → final promoted `primary` 0.4021 (**+6.2pp**) across **2 anchor-surviving promotions** (`routingDepth` gen 1, `microloraRank` gen 2) out of 8 generations run — `milestoneReached: true`. The anchor score **rose** alongside the holdout score for both promotions (0.3823 → 0.4070 → 0.4367), i.e. the winners did not trade retained capability for live-task lift in this run.
- **Replay bundle verifies** with the pinned composite-gate fingerprint: `receipts/reachesRoot/contiguousParents/allPromoted/gateUnchanged/gateReExecutes` all `true` (ADR-235 gate re-execution — the verdict is re-derived from sealed scores, not trusted from a log).
- **The structural drift guard fails closed**: an `aggressive` + `ewcLambda=0.02` + `routingDepth=8` genome is flagged `driftRisk: true` and `regressed: true` purely from its own settings, independent of any suite.
- **EWC++ measurably protects retained capability (the benchmark)** — `packages/evals-servedmodel/__tests__/bench/ewc-benchmark.test.ts`, isolating `ewcLambda` as the only variable at maximum drift settings (rank 4, routing depth 8, `aggressive`): `ewcLambda=0.02` → core-item quality 0.168 (`driftRisk: true`) vs `ewcLambda=0.6` → core-item quality 0.392 (`driftRisk: false`) — a **+22.45pp retained-capability gain**, at a **-7.52pp** cost to live-task quality (the stability/plasticity tradeoff §5 names as limit 4 — never free). A second bench case shows deeper adaptation (rank 4 / depth 8 / `balanced`) beating shallow (rank 1 / depth 1 / `off`) on BOTH quality (0.605 vs 0.262) and cost-per-win (0.0029 vs 0.0060 USD) — more adaptation surface amortizes cost by rescuing more items over the commit threshold.
- **Distillation is deterministic**: the same `PromotedAdaptationState` always distills to the same genome (bit-for-bit equal), so a replay bundle built from a distilled candidate stays reproducible.

### 7.3 Still deferred — the honest boundary (unchanged in kind from §1.1)

**No ruvllm model was loaded or served this session.** `ruvllmClient.ts` is real, wired, and gated exactly like `packages/darwin-mode/src/ruvllm-mutator.ts` and `evals-hle`'s `loadHleFromHub` — it throws a clear, actionable error rather than ever silently substituting synthetic data for a live number. The remaining "next experiment" from §4 (serve a local model via ruvllm, run a real interaction stream, distill its actual SONA/MicroLoRA state, gate the resulting candidate on a real holdout) is **not attempted here** — it needs a running `ruvllm serve` instance with a loaded model (a real infra dependency this session did not stand up, and this task was explicitly scoped away from touching the concurrently-running live SWE-bench Docker harness). What moved: the machinery that a real run would plug into now exists, is tested, and is fingerprint-pinned — the honest gap shrank from "does this pipeline work at all" to "point the same SolveFn at a real endpoint."

[ruvnet/metaharness#109]: https://github.com/ruvnet/metaharness/issues/109
