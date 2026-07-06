# ADR-234: Two-layer learning — ruvllm micro-loop (SONA/MicroLoRA/EWC++) under the flywheel macro-loop auditor

- **Status**: Proposed — ruvllm adaptation primitives verified by execution; the combined-lift claim is a DESIGN claim, gated on the same holdout discipline (unproven end-to-end)
- **Date**: 2026-07-05
- **Deciders**: ruv
- **Tags**: ruvllm, ruvector, flywheel, microlora, sona, ewc, catastrophic-forgetting, two-layer-learning, local-inference, promotion-gate, metaharness
- **Extends**: the `@metaharness/flywheel` engine (frozen `meetsPromotionRule`, anchor suite, signed receipts, replay bundles), [[ADR-233]] (HLE policy-evolution adapter — the answer-production policy the macro-loop tunes)
- **Verified this session (by execution, not help text)**: `ruvllm_status`, `ruvllm_microlora_create` + `ruvllm_microlora_adapt`, `ruvllm_sona_create` + `ruvllm_sona_adapt`.

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
