# router-calibration-loop

Closes the loop between `@metaharness/turn-credit` and `@metaharness/router`:
on identical seeded episodes, do **turn-credit-derived quality labels**
(`toQualityLabels(processTrajectory(...))`) produce a better-calibrated router
than **naive terminal 0/1 labels** — and does better calibration buy cheaper
routing at the same quality bar?

**Result (measured, synthetic): MIXED.** Claim 1 (calibration) passes
numerically on all 3 seeds, but for a degenerate reason the numbers expose;
claim 2 (economics) is **refuted on all 3 seeds**. The mechanism finding is
that `toQualityLabels` emits within-trajectory **relative** labels that carry
essentially zero outcome-level information — so used raw as
`RouterExample.quality` they cannot drive bar-based routing, even though they
cleanly separate informative from distractor turns *inside* a trajectory.

- `lib.mjs` — seeded simulator, labeling arms, routers, measurement.
- `run.mjs` — compact tables + per-claim verdicts; `--check` re-runs everything
  and fails on any byte difference.
- `assert.mjs` — determinism + invariant gate (exit 0 = pass).

Run: `node run.mjs` (or `node run.mjs --check`), then `node assert.mjs`.

## Design (fixed once, before results)

- **Tasks**: 8-dim embeddings with components U(−1,1); latent difficulty
  `d = σ(3·w·x)` along a fixed direction `w`. Two candidates with latent
  success probabilities: `p_cheap = clip(0.95 − 0.85·d)` (collapses on hard
  tasks), `p_frontier = clip(0.95 − 0.15·d)`; prices 0.8 vs 12 $/MTok.
- **Episodes**: each of 200 training tasks is run by BOTH models. A run draws
  the terminal outcome `Bernoulli(p)`, then a 6-turn trajectory: each turn is
  'work' (evidence aligned with the realized outcome, magnitude U(0.4,1.2)×0.8)
  or 'distractor' (zero signal) with probability 0.5, plus N(0, 0.3) noise on
  every turn. Each turn gets the task embedding + N(0, 0.05) jitter.
- **Arms (identical episodes, identical embeddings, only labels differ)**:
  - *naive*: every turn example gets the trajectory's terminal outcome (0/1);
  - *credit*: `processTrajectory` (mode `verifier-delta-proxy`, prior 0.5,
    `PAPER_DEFAULTS`) → `toQualityLabels` per-turn graded labels in [0,1].
- **Routers**: `new Router({candidates, k: 5, qualityBar: 0.7})` per arm
  (1200 examples per candidate per arm).
- **Held-out measurement** (200 fresh tasks/seed, common random numbers: one
  outcome draw per (task, model) and one token count per task shared by both
  arms):
  1. *Calibration*: `calibrationReport` over (predictedQuality, realized 0/1)
     for both candidates — ECE + Brier per arm, plus an oracle reference that
     predicts the true latent `p`.
  2. *Economics*: `route()` each task at the shared bar; realized quality =
     outcome of the routed model; cost = `costPerMTok × tokens / 1e6`.
- Seeds 11, 23, 47; every reported number round6'd.

## Measured results (SYNTHETIC)

Calibration — held-out predictedQuality vs realized 0/1, lower is better:

| seed | naive ECE | naive Brier | credit ECE | credit Brier |
|------|-----------|-------------|------------|--------------|
| 11   | 0.275500  | 0.290900    | 0.228075   | 0.278243     |
| 23   | 0.272500  | 0.287700    | 0.237442   | 0.274194     |
| 47   | 0.279500  | 0.286700    | 0.198380   | 0.260644     |
| mean | 0.275833  | 0.288433    | 0.221299   | 0.271027     |

Oracle reference (predicting the true latent p on the same draws): mean ECE
0.047213, Brier 0.161035 — **both arms are far from calibrated**.

Economics — 200 held-out tasks/seed at qualityBar 0.7 (common random numbers):

| seed | arm    | cost ($) | realized quality | cheap share | metBar share |
|------|--------|----------|------------------|-------------|--------------|
| 11   | naive  | 1.712053 | 0.750000         | 0.440000    | 0.935000     |
| 11   | credit | 1.490091 | 0.675000         | 0.510000    | 0.050000     |
| 23   | naive  | 1.255696 | 0.720000         | 0.585000    | 0.875000     |
| 23   | credit | 1.710002 | 0.715000         | 0.445000    | 0.040000     |
| 47   | naive  | 1.532036 | 0.730000         | 0.510000    | 0.920000     |
| 47   | credit | 1.604007 | 0.705000         | 0.480000    | 0.070000     |
| mean | naive  | 1.499928 | 0.733333         | 0.511667    | 0.910000     |
| mean | credit | 1.601367 | 0.698333         | 0.478333    | 0.053333     |

References: always-cheap cost 0.192563 / quality 0.503333; always-frontier
cost 2.888452 / quality 0.893333 (means).

### Verdicts

- **Claim 1 — credit ECE < naive ECE: SUPPORTED (3/3 seeds), with a caveat.**
  The credit arm's win is low-resolution, not sharpness: its predictions
  cluster at ~0.48 (sd ≈ 0.11) because every trajectory's credit labels are
  standardized around their own mean, so the k-NN average reverts to ~0.5
  everywhere — a near-base-rate predictor, which ECE rewards. The naive arm's
  predictions are near-binary (sd ≈ 0.43): with 0.05 turn jitter the k=5
  neighborhood of a query is dominated by the 6 turns of one nearby
  trajectory, so naive predictions are effectively 1-NN over 0/1 outcomes —
  sharp but badly calibrated. Brier, which also prices resolution, shows a
  much smaller gap (0.271 vs 0.288, both ≈ 0.11+ above the 0.161 oracle).
  This is exactly the calibration module's documented caveat: "a predictor
  that always says the base rate is perfectly calibrated and useless for
  routing".
- **Claim 2 — credit cost ≤ naive cost at equal-or-better quality: REFUTED
  (3/3 seeds).** The credit router's ~0.48 predictions almost never clear the
  0.7 bar (metBar 5.3% vs 91.0%), so it falls back to best-predicted — a
  near-coin-flip that routes hard tasks to the cheap model. Realized quality
  is lower on every seed (mean 0.698 vs 0.733) and mean cost is *higher*
  (1.601 vs 1.500 $); the conjunction fails on all seeds.

### Why (measured diagnostics)

The credit signal is real but **relative**: mean credit label on work turns
0.705 vs distractor turns 0.256 (pooled over seeds) — the mechanism reliably
identifies which turns mattered. But mean credit label on success trajectories
is 0.478 vs 0.480 on failures — within-trajectory standardization removes the
outcome level entirely. `RouterExample.quality` is consumed as an **absolute**
outcome scale, so raw `toQualityLabels` output is the wrong currency for it: a
correct closing of this loop needs the outcome level reintroduced (e.g.
outcome-anchored labels with credit as a per-turn modulation) — a follow-up
design, deliberately not retro-fitted here.

## Honest bounds

- **SYNTHETIC mechanism proof, not a benchmark claim.** Embeddings are
  simulated feature vectors; the cheap/frontier success surfaces, evidence
  generator, and distractor structure are constructed. Router k-NN behavior
  under these sim features (e.g. the neighborhood-collapse effect that makes
  naive predictions near-binary) may not transfer to real embedding spaces or
  real trajectory data. This experiment is evidence about the LABEL-QUALITY
  mechanism feeding the router, not about production routing.
- Evidence mode is `verifier-delta-proxy` — ordinal proxy scalars, not
  AgentOPSD log-prob gaps.
- The claim-1 "pass" is reported as measured but should not be read as "credit
  labels calibrate the router": the diagnostics show it is a resolution
  artifact, and claim 2 shows it buys nothing.
- Nothing here satisfies or approaches the ADR-248 §6 LIVE acceptance gate;
  any artifact derived from this experiment must carry `data_source:
  'SYNTHETIC'` (the result object does).
- Determinism: mulberry32-seeded only; `node run.mjs --check` and
  `node assert.mjs` prove byte-identical repeated runs.
