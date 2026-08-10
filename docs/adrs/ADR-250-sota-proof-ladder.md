# ADR-250: The SOTA-proof ladder — explicit rungs from mechanism proof to benchmark claim

- **Status**: Accepted — rung 2 artifacts shipped and replay-verified; rung 3 EXECUTED twice (honest nulls on a saturated domain — see appendix); rungs 4-5 explicitly open.
- **Date**: 2026-08-10
- **Deciders**: ruv
- **Tags**: proof-ladder, honesty-discipline, acceptance-gates, turn-credit, flywheel, router, darwin-mode, synthetic, replay, receipts, metaharness
- **Extends**: ADR-236 (bounded-claims discipline / SWE-bench honest null), ADR-237 (evals-math live GSM8K fast domain), ADR-243 (mechanism-testbed-not-benchmark precedent), ADR-248 (`@metaharness/turn-credit` + the §6 acceptance gate), ADR-249 (darwin scorer signal seams)
- **Artifacts**: `experiments/turn-credit-acceptance/{lib,run,assert}.mjs` + `verdict.json`, `experiments/signal-flywheel/{config,run,verify}.mjs` + `bundle.json`, `experiments/router-calibration-loop/{lib,run,assert}.mjs`

---

## Context

MetaHarness now has several mechanisms whose *ultimate* claims — "recursive
turn-level credit improves real agents", "the flywheel compounds on real
domains", "credit-calibrated routing is cheaper" — are expensive to prove and
easy to overstate. The repo's history shows both failure modes and their
antidotes: ADR-236 shipped an honest null on real SWE-bench rather than a
fabricated lift; ADR-243 shipped a synthetic coordination testbed and labelled
it "mechanism testbed, not benchmark claim"; ADR-248 froze a §6 acceptance
gate *before* any trust escalation and left it unsatisfied.

What was missing is a single, explicit ladder saying **which rung any given
artifact sits on**, so that a signed PASS on a synthetic gate can never be
quoted as a live result, and so that each open rung has a concrete, runnable
next step instead of a vague "future work".

Today (2026-08-10) three adversarially-reviewed experiments landed, all on the
same rung — mechanism efficacy in sealed synthetic environments with frozen
gates and signed, replayable artifacts:

1. **`experiments/turn-credit-acceptance/`** — the ADR-248 §6 gate built as an
   offline executable artifact and run end-to-end on a seeded synthetic
   long-horizon environment (12-30 turn episodes, 7-action set with one
   governance-forbidden action, 300 tasks × 3 seeds per arm, identical task
   seeds across arms, learner fed *only* through `@metaharness/turn-credit`
   outputs). Frozen gate verdict: **PASS** on all three clauses — lift
   0.637778 ≥ 0.05, invocation-count overhead 0.092113 < 0.20,
   governance-violation change −59.000000 ≤ 0 (mean violations 84.666667 →
   25.666667: the forbidden action earns the worst per-label credit and its
   prior decays, with no forbidden-specific logic in the learner). Mean
   completion 0.332222 (baseline) → 0.970000 (credit). `verdict.json` carries
   `data_source: "SYNTHETIC"` and an Ed25519 receipt verified in-process
   (`receipt_verified: true`; a tampered payload is asserted to fail).
2. **`experiments/signal-flywheel/`** — the ADR-234/235 flywheel run entirely
   through the ADR-249 scorer seams (turn-credit-derived `traceQuality` +
   deterministic cost-units), under the **default** frozen
   `meetsPromotionRule`, holdout + never-optimized anchor. 8 generations,
   32 candidates, 2 anchor-surviving promotions (`milestone_reached: true`),
   holdout primary 0.330911 → 0.330967 → 0.897456 (×2.712077 over root), with
   real gate discipline in both directions: the cost seam produced a genuine
   `primary_regressed` rejection, and the strict noopRate clause refused every
   post-plateau candidate including one at primary 0.950695 (rejection counts:
   `noop_rate_not_improved` 28, `primary_regressed` 20,
   `cost_per_win_worsened` 12, conjunctive). Committed `bundle.json` is
   `data_source: 'SYNTHETIC'`; `verify.mjs` replay-verifies all six checks
   including ADR-235 gate re-execution against the pinned default-gate
   fingerprint and exits 0.
3. **`experiments/router-calibration-loop/`** — turn-credit → router loop on a
   seeded synthetic sim (cheap $0.8/MTok vs frontier $12/MTok, 3 seeds).
   **Result: MIXED, reported as such.** Claim 1 (credit-arm ECE < naive-arm
   ECE) is numerically supported 3/3 seeds (mean ECE 0.221299 vs 0.275833;
   Brier 0.271027 vs 0.288433) but the diagnostics expose it as a
   low-resolution artifact — credit predictions cluster near the base rate
   (sd ≈ 0.11) while the oracle reference sits at ECE 0.047213 / Brier
   0.161035, so *both* arms are far from calibrated. Claim 2 (credit cost ≤
   naive at equal-or-better quality) is **REFUTED 3/3 seeds** (mean cost
   $1.601367 vs $1.499928; realized quality 0.698333 vs 0.733333; metBar
   5.3% vs 91.0%). Mechanism finding: credit labels cleanly separate work
   from distractor turns (mean 0.705 vs 0.256) but carry zero outcome-level
   information (0.478 success-trajectory vs 0.480 fail-trajectory) — raw
   `toQualityLabels` output is a **relative** signal and the wrong currency
   for the absolute `RouterExample.quality` scale. The gate correctly
   rejecting it is the positive result for the machinery.

All three are deterministic (seeded RNG only, `--check`/assert byte-identity
proven), all carry `data_source: 'SYNTHETIC'` on any signed artifact, and none
claims the ADR-248 §6 LIVE gate.

## Decision

Codify the **SOTA-proof ladder** as the repo's claims taxonomy. Every result,
README, and signed artifact MUST state its rung; a claim at rung N never
implies rung N+1.

### Rung 1 — Mechanism correctness (SHIPPED)

Unit/property tests over pure library code: the ADR-248 belief recursion,
bounded reshaping invariant (`m_k > 0`, `|m_k − 1| ≤ λ·b`), adapters, receipt
digests; the ADR-249 seams (additive optional argument, zero behaviour change
when absent). Evidence: `packages/turn-credit/__tests__/`,
`packages/darwin-mode/__tests__/scorer-signals.test.ts`. Proves the code does
what its spec says. Proves nothing about efficacy.

### Rung 2 — Mechanism efficacy in sealed synthetic environments (TODAY's rung — SHIPPED)

A frozen gate (thresholds and cost model fixed before the first run) applied
to a seeded synthetic environment, two-arm where applicable, with signed and
replay-verifiable artifacts, and nulls/mixed results committed unchanged.
Today's three experiments are this rung's evidence, and they demonstrate all
three possible honest outcomes:

- **PASS** — turn-credit-acceptance: the §6 gate *machinery* passes on all
  three clauses (lift 0.637778, overhead 0.092113, violations −59.000000).
- **Compounding under a strict gate** — signal-flywheel: ×2.712077 lift with
  the default gate making (and refusing) every promotion, replay PASS.
- **Correct rejection** — router-calibration-loop: claim 2 refuted 3/3 seeds;
  the calibration/economics gate rejecting the raw credit-label currency is
  the machinery working.

Rung 2 proves that the *loop closes*: signals flow end-to-end, gates evaluate
real clauses, receipts verify, replays re-execute. It proves **nothing** about
real agents — synthetic environments are favorable by construction (see
Honest bounds).

### Rung 3 — Live cheap-domain compounding (OPEN)

The ADR-237 pattern: a real model on a real public dataset with exact-match
gold scoring, frozen splits, the untouched `meetsPromotionRule`, and a signed
`data_source: LIVE` replay bundle. The pipeline is already validated
end-to-end at $0 (ADR-237's 3-item, 1-generation smoke run); the full
compounding experiment has NOT been run.

**Command/preconditions:** a local OpenAI-compatible endpoint (e.g.
`qwen2.5-coder:7b` via ollama at `localhost:11434` — a ≥16 GB GPU per
ADR-237's model-fit note), the committed frozen split
`packages/evals-math/bench/gsm8k-frozen.json`, then:

```bash
node packages/evals-math/bench/math-live-run.mjs \
  --base-url http://localhost:11434/v1 --api-key-env NONE \
  --model qwen2.5-coder:7b --holdout 40 --generations 6 --resume
```

To put *turn-credit* itself on this rung, the same runner must additionally
feed `ScoreSignals.traceQuality` from real trajectories (the ADR-249 seam is
already in place; the ScorePair-producing teacher pass is the missing wiring,
which lives upstream in the caller per ADR-248).

### Rung 4 — The ADR-248 §6 LIVE acceptance gate (OPEN)

300 long-horizon **real RuFlo trajectories** × 3 seeds, two arms, the same
frozen clauses (lift ≥ 5pp, overhead < 20% measured as real processing cost,
zero governance-violation increase). The offline harness at
`experiments/turn-credit-acceptance/` IS the executable gate definition —
the live run replaces its synthetic environment with RuFlo's replay/teacher
machinery emitting real `ScorePair`s (companion-repo wiring per ADR-248 §3).

**Preconditions:** the `ruvnet/ruflo` teacher-pass PR (replay each recorded
action with/without retrieved context → `ScorePair`s), real trajectory
capture at 300×3 scale, and a real cost measurement replacing the frozen
invocation-count model. Until this rung passes, **credit signals stay
advisory** — exactly as ADR-248 §6 mandates. Today's synthetic PASS does not
move that line.

### Rung 5 — External benchmark claims (OPEN)

SWE-bench (resuming the ADR-236 arc with a solver that has headroom — the
honest null was base-solver-limited at ~1/25 regardless of model) and
Harness-Bench (arXiv:2605.27922). Requires the full bench infrastructure:
official Docker gold-scoring harness, machine-hours budget, and a capable
base solver. No MetaHarness artifact to date makes any claim on this rung.

**Preconditions/commands:** the ADR-236 D1 runner shape (adapter → solver →
official Docker gold-scoring → frozen gate → signed replay bundle) with a
multi-turn agentic solver replacing the open-loop single-shot shim; budget
approval for the machine-hour-gated run. Harness-Bench additionally requires
building its harness adapter — not started.

### Ladder rules (normative)

1. Every README and signed artifact states its rung and its `data_source`
   (`SYNTHETIC` for rungs 1-2; `LIVE` only at rung 3+).
2. A rung-2 PASS is a claim about **machinery**, never about agents, models,
   or benchmarks. The words "satisfies the §6 gate" are reserved for rung 4.
3. Nulls and rejections at any rung are committed unchanged; a gate correctly
   rejecting is a positive result for the machinery (ADR-236 precedent,
   re-confirmed today by router-calibration-loop).
4. Rung skipping is prohibited: no rung-5 claim without rung-4 evidence for
   any mechanism the claim depends on.

## Consequences

- The repo has one vocabulary for "how proven is this": today's three
  experiments are pinned to rung 2, and any future quote of their numbers
  must carry that rung label. The gap between "the gate machinery passes"
  and "the gate is satisfied" is now structural, not stylistic.
- Rungs 3-5 each have a concrete runnable next step with stated
  preconditions, so "open" means "queued behind a known cost", not
  "hand-waved". Rung 3 is $0 and minutes-long; rung 4 is gated on companion-
  repo wiring and real-trajectory capture; rung 5 is gated on machine-hours
  and a capable base solver.
- The router-calibration-loop refutation feeds a design consequence forward:
  closing the credit→router loop needs outcome-anchored labels with credit as
  per-turn modulation, not raw `toQualityLabels` output. That follow-up is a
  new rung-2 experiment before any rung-3 attempt on routing economics.
- The credit-arm violation *reduction* (−59.000000 mean) is a rung-2
  observation about the synthetic environment's construction (the forbidden
  action's negative teacher deltas), not a safety claim about real agents;
  promoting it to a claim requires rung 4.

## Honest bounds

- **Rungs 3, 4, and 5 are NOT claimed.** Nothing shipped today satisfies,
  approaches, or partially discharges the ADR-248 §6 LIVE acceptance gate;
  it **remains OPEN** and credit signals remain advisory.
- **Synthetic environments are favorable by construction.** In all three
  experiments the authors of the mechanism also wrote the generator: teacher
  signals correlate with latent usefulness because the generator makes them,
  latent structure is stationary, action/lever spaces are tiny, and better
  levers genuinely produce better evidence by design. Rung-2 PASSes are
  mechanism proofs, not benchmark claims, and reproduce no external number.
- **The overhead clause is only as honest as its frozen cost model.** The
  0.092113 figure is invocation-count based; the same credit pass measures
  ≈ 0.809534 under the diagnostic uniform stage-op count because the toy
  environment's turns are trivially cheap. Rung 4 must measure real
  processing cost; neither synthetic number substitutes.
- **Evidence mode is a proxy.** All three experiments ran turn-credit in
  `verifier-delta-proxy` mode (`proxy: true` end-to-end), not AgentOPSD's
  log-prob gaps; magnitudes are ordinal.
- **The calibration "win" is not a win.** Claim 1's 3/3-seed support is a
  resolution artifact of within-trajectory standardization (near-base-rate
  predictor); claim 2's 3/3-seed refutation is the operative result. This
  ADR cites it as evidence the *gate discipline* works, nothing more.
- **Signature bytes are per-process.** Committed payloads are byte-stable
  across runs (asserted by each experiment's `--check`/assert); Ed25519
  `signature`/`publicKey` bytes differ per run because the library's
  `makeSigner` mints a per-process key. Every receipt is verified in-process
  and tamper-checked.
- Rung labels describe *evidence strength inside this repo's discipline*;
  they say nothing about the cited preprints' own reproducibility (ADR-248
  §4's caveat on AgentOPSD stands).

## Rung-3 evidence appendix (2026-08-10, same-day live runs)

Rung 3 was EXECUTED twice on the frozen GSM8K split (fp `5c2af7519d09`,
frozen `mathPromotionRule`, never-optimized anchor, `dataSource: LIVE`,
Ed25519 replay PASS on both bundles):

| run | model | scale (holdout/anchor/gens) | root primary | promotions | verified improvements | anchor | est. token spend |
|---|---|---|---|---|---|---|---|
| free | `google/gemma-4-26b-a4b-it:free` | 20/12/3 | 0.900 | 0 of 12 candidates | 0 | 0.833 held | ~$0.14 est., $0 actual |
| paid | `deepseek/deepseek-v3.2` | 40/30/6 | 0.975 | 1 of 24 (confidenceRule, primaryΔ 0 — secondary-axis win) | 0 | 0.867 held | ~$0.44 est., ≲$0.25 actual |

**Honest reading: two nulls, and the nulls are the finding.** Modern models
saturate GSM8K (0.900 free / 0.975 paid at the root policy), so there is no
headroom for operating-policy lift and the frozen gate correctly refused to
promote noise (35 of 36 candidates rejected; zero anchor regressions). This
reproduces ADR-237's null with two more models at two price points, and it
REDIRECTS rung 3 rather than closing it: live policy-lift evidence requires a
domain where the base model leaves recoverable headroom — the repo's harder
suites (evals-hle, evals-sql) or the long-horizon RuFlo tasks that rung 4's
§6 gate targets. Scaling the model up on a saturated domain buys accuracy,
not evidence. Bundles: `packages/evals-math/bench/proof-bundle-gsm8k-gemma4-26b-free.json`,
`.../proof-bundle-gsm8k-deepseek-v32-paid.json` (force-added per the ADR-237
bundle precedent).
