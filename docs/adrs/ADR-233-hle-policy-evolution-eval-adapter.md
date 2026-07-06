# ADR-233: HLE as a policy-evolution problem — `@metaharness/evals-hle`, a flywheel benchmark adapter

- **Status**: Proposed — adapter landed + $0 SYNTHETIC acceptance test green (7/7); live run gated on `cais/hle` access + a budget confirm
- **Date**: 2026-07-05
- **Deciders**: ruv
- **Tags**: metaharness, flywheel, hle, eval, benchmark-adapter, policy-evolution, promotion-gate, anti-overfit, calibration, routing, verifier-stack
- **Extends**: [[ADR-232]] (cost-aware output-mode decoder — the "decisions, not prose" + cost-per-accepted discipline), the `@metaharness/flywheel` engine (frozen `meetsPromotionRule`, signed receipts, replay bundles)
- **Reference implementation**: `packages/evals-hle/` (`@metaharness/evals-hle@0.1.0`) — genome, subject classifier, answer normalizer, subject verifier stack, 3-pass cost-aware routing, confidence calibration, leakage detector, four-set data contract, composite gate, `makeHleEvaluator`/`makeHleProposer`; `__tests__/adapter.test.ts` (7 passing, $0 synthetic).

---

## 1. Context

HLE (Humanity's Last Exam) is closed-answer expert QA — ~2,500 expert-vetted questions (Artificial Analysis evaluates the 2,158 **text-only** ones as pass@1 via an equality checker) designed to resist internet lookup and require specialist expertise. The current top public score there is **Claude Fable 5 at 53.3%**, ahead of Opus 4.8 (45.7%) and Gemini 3.1 Pro Preview (44.7%).

HLE is **not a natural agentic benchmark**. It is a knowledge/reasoning ceiling, not a tool-use or execution-strategy problem, so the base-model ceiling dominates. That makes it the sharpest possible test of a claim we must be careful with: *does the harness policy — separate from the model — recover measurable, defensible lift?*

The honest framing (and the one this ADR adopts): **treat HLE as a policy-evolution problem over answer PRODUCTION, not a model-training problem.** Freeze the models, the evaluator, and the private holdout. Let the flywheel evolve only the harness policy that decides how to answer, verify, route, abstain, and calibrate. **The policy — not the model — is the genome.**

The recoverable win on HLE is **preventable loss**, not "reasoning harder":

| Bucket | Est. recoverable |
|---|---|
| Formatting mistakes | 0.5–2 pp |
| Numeric / unit normalization | 0.5–2 pp |
| Subject-specific verification | 1–3 pp |
| Cross-model routing | 1–4 pp |
| Self-consistency / candidate selection | 2–6 pp (at much higher cost) |

## 2. Decision

Ship **`@metaharness/evals-hle`** as a **benchmark adapter, not core logic**. It exports a `Proposer` + `Evaluator` (+ a stricter composite `PromotionRule`) that plug into the benchmark-agnostic `@metaharness/flywheel`. The flywheel never learns what "HLE" is — everything HLE-specific lives in the caller, exactly as the SWE-bench adapter (ADR-D1 track) does.

### 2.1 The genome (small, typed, auditable)

`HLEPolicyGenome` = per-subject `{solverStyle, answerFormat, verificationMode, escalationThreshold, maxCandidates, confidenceRule, abstainThreshold}` over a fixed subject taxonomy + a `global` block (`normalizeFinalAnswer`, `requireAnswerOnly`, `allowToolUse`, `maxCostPerQuestionUsd`, `maxLatencyMs`). Every lever is a **bounded enum or a clamped number** — never free prose. Arbitrary prose mutation is how you get benchmark superstition; `clampLever` forces any proposal (even an LLM's) back into schema. The typed genome round-trips through the flywheel's flat `Policy` bag; the flat keys ARE the mutation classes.

### 2.2 The pipeline (preventable-loss recovery)

`classify → select policy → cheap first solve → normalize → subject verifier → confidence → escalate/abstain → final answer`. The verifier stack is **subject-specific and mostly deterministic** (symbolic recomputation, unit/dimension checks, multi-solver agreement) — explicitly **NOT** a generic "critic says yes" (ADR-226 measured read-only strong advice at **zero marginal resolves for 5.4× cost**; the useful lever is executor policy + real checks). Routing is 3-pass (cheap → mid → frontier) with escalation gated by confidence + verifier disagreement + format validity, and a hard per-question cost cap.

### 2.3 The gate: a stricter composite that preserves the frozen default

The flywheel's default `meetsPromotionRule` is **FROZEN and is not edited**. `hlePromotionRule` **calls it verbatim** and ANDs HLE extras on top — the flywheel supports rule injection, and the replay bundle fingerprints whatever rule ran, so the composite is itself frozen + verifiably unchanged for this deployment. Extras:

- **Materiality (disjunctive)**: an **accuracy win** (`accuracy ≥ baseline + 0.02`) OR a **cost win** (accuracy held, cost/correct ≤ 0.60× baseline). This mirrors the acceptance test's OR.
- format-error not worse; calibration (ECE) not worse; ≤ 2 subject regressions.
- The frozen base already guarantees — and MORE strictly than the acceptance test's cost tolerance — cost/correct never worsens, the no-commit (format-error + abstention) rate **strictly** improves (the harness must make the model *commit more*, not merely cheaper), and the frozen anchor never regresses. We deliberately do **not** admit the acceptance test's "cost up to 1.5× for an accuracy gain" branch: that is competition mode; the shipped product gate never lets cost/correct rise.

### 2.4 Anti-overfit is procedural (the part that matters most)

Four disjoint, content-hashed sets with machinery-enforced roles: **publicDev** (debug + leakage corpus only), **privateTrain** (proposer searches here), **privateValidation** (the gate scores here), **frozenHoldout** (never visible to proposer/mutation/tuning; confirmed **exactly once**, at the end). A **leakage detector** runs on every candidate before scoring (n-gram overlap with public examples, exact-question-seen, benchmark-artifact language, dataset-specific hacks) and **fails closed** — any hit marks the policy `regressed`, so the frozen gate rejects it. Split fingerprints go in the replay bundle so a reviewer can prove the split was fixed.

## 3. What we claim (and what we will not)

**Target claim**: MetaHarness policy tuning can plausibly reach **95–105% of the top frontier score at materially lower cost**, and **+3–6 pp above the same model** with a tuned verifier + routing policy. Modeled arms: static frontier ~53% → flywheel-tuned single model ~55–58% → router+verifier ~56–60% → multi-candidate/multi-model ~59–63% (competition mode, 2–6× cost, serious overfit risk). Above ~63% from harness policy alone is unlikely without a stronger base model, better tools, or contamination.

On 2,158 text questions, **1 pp ≈ 22 correct answers**; a +5 pp lift ≈ 108 more correct.

**We will NOT claim a ~20 pp jump.** On HLE that would signal contamination, answer leakage, or public-benchmark overfit — not harness lift.

**Frozen-holdout acceptance test** (constant `FROZEN_HOLDOUT_ACCEPTANCE`): on ≥500 frozen HLE questions, the flywheel policy is real iff it beats the static frontier baseline by **≥ 3 pp with cost/correct within 1.5×**, OR matches the score at **≥ 40% lower cost/correct**. Confirmed exactly once. After ≥20 generations, an external reviewer must be able to replay the signed bundle and verify the promoted policy improves private validation, preserves the anchor, holds-or-cuts cost/correct, and was frozen-holdout-confirmed exactly once.

## 4. Status of evidence

- **$0 SYNTHETIC acceptance test — GREEN (7/7).** On a deterministic synthetic fixture (`dataSource: 'SYNTHETIC'`), the full adapter drives the real flywheel engine to a **compounding lift curve (50% → 54% → 58%, 2 anchor-surviving promotions, then plateau when no-op hits 0)** — squarely in the modeled "flywheel-tuned single model 55–58%" band. The replay bundle verifies against the pinned composite-gate fingerprint; the frozen `meetsPromotionRule` is proven composed verbatim (its base reasons surface; its fingerprint is unchanged); leakage fails closed.
- **LIVE run — DEFERRED (blocked + budget-gated).** `cais/hle` is a **GATED HuggingFace dataset**: a human must accept its terms at huggingface.co/datasets/cais/hle before any token can read it (the org's `HUGGINGFACE_API_KEY` currently 403s). `loadHleFromHub` throws an actionable error rather than ever substituting synthetic data for a real score. **No real HLE number is fabricated anywhere.**
- **Sizing**: begin with **small 25-instance flywheel runs** (not the full ≥500) to validate the live pipeline end-to-end + pin per-question cost before scaling to the ≥500 frozen-holdout acceptance run under a hard $-cap.

## 5. Consequences

- MetaHarness gains a **second real, non-code-repair domain** on the flywheel — the multi-vertical evidence that the `@metaharness/flywheel` engine generalizes with **zero benchmark-specific branches** in the core (the SWE-bench D1 track is the code-repair vertical; this is the expert-QA vertical).
- The composite-gate pattern (call the frozen default verbatim, AND stricter domain clauses, fingerprint the composite) is now demonstrated twice — it is the reusable way to specialize the gate **without weakening the product's frozen promotion rule**.
- To run live: grant `cais/hle` access, then a 25-instance dry-run, then a budget-confirmed ≥500 frozen-holdout acceptance run emitting a signed, replayable proof bundle.
