# FunnelWheel — a verifiably self-improving click funnel

**Freeze the traffic model. Evolve the funnel. Promote only what proves lift.**

This example turns the MetaHarness stack into a click-funnel optimization
system: the funnel's operating policy (headline, CTA, form length, page
weight, social proof, offer framing, checkout flow, urgency tactic) evolves
one lever at a time, and a change only ships when it clears a **frozen,
conjunctive promotion gate** — on a holdout cohort *and* a never-optimized-
against mobile-heavy anchor — with every promotion **Ed25519-signed** and
independently **replayable**.

| Package | Role here |
| --- | --- |
| [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) | Mutation strategy: one lever per candidate, `paretoFront` (CVR × −CAC × rev/visitor) selects the variant to propose |
| [`@metaharness/flywheel`](https://www.npmjs.com/package/@metaharness/flywheel) | The promotion loop: `runFlywheelGenerations`, custom frozen gate, receipts, lineage DAG, lift curve, `verifyReplayBundle` |
| [`metaharness`](https://www.npmjs.com/package/metaharness) | The harness factory around it — `npm run score` prints the repo scorecard |

## Run it

```bash
npm install
npm run evolve    # ~2s, fully deterministic, no network, no API key
```

Outputs `results/summary.json` (business-facing report) and
`results/replay-bundle.json` (the signed, independently verifiable bundle).

## What a run produces (SYNTHETIC traffic, seeded + deterministic)

- **CVR 1.48% → 8.66% (5.86×)** on the 9,000-visitor holdout; CAC **$57.99 → $9.90**;
  bounce **58.1% → 40.1%**; ROAS **1.13 → 6.59**.
- **7 promotions in 12 generations**, each re-based on the previous winner —
  a compounding lift curve, not a scatter of one-off A/B wins.
- The frozen mobile-heavy **anchor** improved too (1.27% → 8.67%) — the lift is
  not Goodharted onto the holdout.
- **The gate blocked the dark pattern 11/11 times.** The proposer's exploration
  pass is deliberately compliance-blind (it chases raw CVR, like a growth team
  under quota) and kept proposing `urgency: fake_countdown` — the single
  biggest raw-CVR lever in the simulator. Every attempt was rejected with
  `compliance_regressed`. The shipped funnel converts 5.9× *with*
  `urgency: none`.
- `verifyReplayBundle` passes all six checks — receipts, lineage to gen-0,
  no smuggled rejects, pinned gate fingerprint, and a full **gate re-execution**
  against each promotion's sealed scores.

## Why this shape

An A/B test tells you a variant won once. The flywheel makes winning
**auditable and compounding**: the gate is frozen (fingerprinted), the anchor
is never optimized against, every promotion is signed, and an outside reviewer
can replay the whole chain with zero trust in the machine that produced it.

The traffic here is a seeded simulator (stamped `SYNTHETIC` in the bundle) so
the loop is reproducible and free. To point it at production, replace
`simulate()` in `src/funnel.mjs` with your analytics query (same four-axis
`Score` projection) and stamp the bundle `LIVE` — nothing else changes.
