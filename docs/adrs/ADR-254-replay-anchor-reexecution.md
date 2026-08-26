# ADR-254: Re-executing the anti-Goodhart anchor clause during flywheel replay

- **Status**: Accepted — fix shipped, regression-tested, verified against every real committed
  `ReplayBundle` in the repo.
- **Date**: 2026-08-26
- **Deciders**: MetaHarness Dream Cycle (autonomous nightly research), slot 1 (flywheel-promotion)
- **Tags**: flywheel, replay, verifier, anti-goodhart, anchor, receipts, provenance, metaharness
- **Extends**: ADR-235 (independent re-executing verifiers + honest-null replay), the frozen
  `meetsPromotionRule`'s anchor clause
- **Prompted by**: a gap explicitly disclosed-not-fixed by the 2026-08-16 flywheel-promotion night
  (PR #205, still unmerged): `verifyReplayBundle`'s gate re-execution never supplied the anchor clause.

---

## Context

ADR-235 established the "re-executing verifier" discipline: `verifyReplayBundle`'s `gateReExecutes`
check re-runs the frozen `meetsPromotionRule` on each PROMOTED commit's *sealed*
`baselineScore`/`candidateScore`, so an external reviewer trusts the gate re-run rather than a logged
verdict. `meetsPromotionRule` (`packages/flywheel/src/gate.ts`) has five conjunctive clauses, one of
which is the anti-Goodhart guard: `if (e.anchor && e.anchor.candidate < e.anchor.baseline)
reasons.push('anchor_regressed')`. The anchor is a frozen, never-optimized-against suite; `run.ts`
computes and enforces it live via a `rootAnchor` closure variable compared against each generation's
winner (`anchorSurvives`, `run.ts:170`).

`gateReExecutes` (`packages/flywheel/src/replay.ts`, pre-fix) built its `PromotionEvidence` as
`{ baseline: c.baselineScore, candidate: c.candidateScore }` only — `evidence.anchor` was never
constructed, so `meetsPromotionRule`'s clause 5 was structurally unreachable during replay. A
promotion whose live anchor check was bypassed, or a bundle edited to claim an anchor-surviving
promotion that never happened, would replay `pass: true` regardless. This is exactly the gap PR #205
(2026-08-16, unmerged) disclosed as a "natural next-night follow-up" after fixing a sibling
full-diagnostic-ledger/verdict-authentication gap in the same function.

The root commit's `LineageCommit.anchorScore` is already set to `rootAnchor` at gen-0
(`run.ts:113`) and carried into every real committed `ReplayBundle`'s `chain` — the data needed to
close the gap was already present and sealed; it was simply never read by the replay verifier.

## Decision

1. **`verifyReplayBundle` now re-checks the anchor clause.** `gateReExecutes` derives
   `rootAnchorSealed` from `chain[chain.length - 1].anchorScore` (the root, already required to be
   present by the pre-existing `reachesRoot` check) and, for each PROMOTED commit whose sealed
   `baselineScore`/`candidateScore` are present, also supplies
   `evidence.anchor = { baseline: rootAnchorSealed, candidate: c.anchorScore }` when both are
   non-null — using `!= null`, not truthiness, so an anchor score of `0` is handled correctly.
2. **Scope is deliberately matched to the pre-existing trust tier, not expanded.** `anchorScore`,
   like `baselineScore`/`candidateScore` before it, is a bare `LineageCommit` field — not covered by
   the Ed25519 receipt signature (`run.ts`'s `signer.sign(...)` payloads are `{kind, id, target,
   verdict, primaryDelta}` only). This fix extends the SAME sealed-field re-execution discipline
   ADR-235 already established for the other three score axes to the anchor axis. It does not attempt
   to harden any sealed field against bundle-editing (as opposed to signature) forgery — that remains
   a separate, larger, explicitly disclosed future gap (see PR #205's own second disclosed item:
   signing `failureReasons`/`Score` fields into the receipt payload).
3. **Purely additive.** No new required field on `ReplayBundle` or `LineageCommit` — the root's
   existing `anchorScore` is the source of truth. A bundle with no anchor suite (`anchorScore: null`
   throughout, the common case when `FlywheelConfig.anchor` is unset) is unaffected: the clause stays
   unchecked, matching prior behavior. Old bundles missing/predating this reasoning still verify
   exactly as before.

## Consequences

- **Correctness:** a promotion that regressed the frozen anchor now fails replay
  (`gateReExecutes: false`) instead of passing silently — closing the specific gap PR #205 disclosed.
- **Zero regression:** `packages/flywheel`'s suite grew 47 → 51 (4 new tests: anchor-regressed →
  fails, anchor-surviving → still passes, exact-boundary equality → still passes, no-anchor-suite →
  unaffected); all 51 pass. `tsc --noEmit` clean; full monorepo build clean.
- **Real-bundle regression check:** all 7 committed `ReplayBundle`s in the repo (`packages/radio/`,
  `kimi-k3-harness/`, `packages/darwin-mode/bench/swebench/`, `experiments/signal-flywheel/`, 3
  `evals-math` proof bundles) still verify `pass: true`. The 2 that use the default gate
  (`darwin-mode` swebench, `signal-flywheel`) both still show `gateReExecutes: true` with the anchor
  clause now actively exercised — the fix closes the gap with no false-positive regression on any
  honestly-produced evidence in the repo.
- **Trust-tier honesty preserved:** this ADR does not claim to have made the anchor un-forgeable by a
  bundle editor — only that it is now checked at parity with the other three gate clauses, which is
  the standard ADR-235 already set. Full sealed-field signing remains future work, tracked as an open
  item in tonight's issue.
- **`meetsPromotionRule` itself is unchanged** — this ADR modifies only the *verifier*, per the
  ADR-235 pattern of tightening the reviewer's re-execution, never the frozen gate.

## Alternatives Considered

- **Add a new signed `root_anchor` receipt / bundle field**, giving the anchor stronger (signature-
  backed) trust than the other three re-executed axes. Rejected for tonight: this would put the
  anchor at a *different* (stronger) trust tier than `baselineScore`/`candidateScore`, which is
  inconsistent, requires new bundle shape / re-signing of existing bundles' root commits, and is a
  meaningfully larger patch for one axis while leaving the other two axes at the weaker tier anyway —
  a real full-signing pass should cover all sealed fields uniformly, not just this one, and is better
  scoped as its own future night's work.
- **Leave the gap disclosed but unfixed a second night in a row.** Rejected — the gap is small,
  well-understood (a second independent research/architecture-review pass this same night both
  reached the same minimal fix independently), and directly actionable with no LLM calls or new
  infrastructure required.

## Test Contract

- `packages/flywheel/__tests__/units.test.ts`, describe block `verifyReplayBundle — gateReExecutes`:
  4 new cases (anchor-regressed fails, anchor-surviving passes, exact-equality boundary passes,
  no-anchor-suite unaffected), alongside the pre-existing 4 cases in the same block (all still green).
- Real-bundle check script (ad hoc, not committed) re-verified all 7 real `ReplayBundle` JSON files
  in the repo against the built `@metaharness/flywheel` dist, both in fingerprint-only mode and, for
  the 2 bundles using the default gate, with `promotionRule: meetsPromotionRule` supplied to exercise
  the new anchor re-check path.

## References

- ADR-235 — Independent re-executing verifiers + honest-null replay for flywheel proof bundles.
- PR #205 (2026-08-16, unmerged) — disclosed this gap (and a sibling full-diagnostic-ledger /
  verdict-authentication gap, fixed that night) without fixing it.
- `packages/flywheel/src/replay.ts`, `run.ts`, `gate.ts`, `types.ts`.
