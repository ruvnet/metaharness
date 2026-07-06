# ADR-235: Independent re-executing verifiers + honest-null replay for flywheel proof bundles

- **Status**: Accepted — verifier bug fixed + regression-tested (`@metaharness/flywheel` 0.1.2); the re-execution enhancement is the forward plan
- **Date**: 2026-07-06
- **Deciders**: ruv
- **Tags**: flywheel, replay, verifier, receipts, honest-null, provenance, metaharness
- **Extends**: the `@metaharness/flywheel` ReplayBundle / `verifyReplayBundle` (ADR-233/234 lineage), the frozen `meetsPromotionRule`
- **Prompted by**: a review of `ruvnet/sublinear-time-solver#64` (its `integrations/metaharness-proof`) + a real honest-null D1-S4 SWE-bench run whose bundle wrongly failed replay.

---

## 1. Context — two signals converged

**(a) A worthwhile external discipline.** PR #64's `metaharness-proof` ships **independent verifiers that RE-EXECUTE from sealed inputs and trust no service logs**: for each generation they recompute every hash and **re-run the real ADR-076 promotion gate** on the sealed raw outcomes, asserting the decision reproduces **bit-for-bit** (`verify-lineage`: `check('decision reproduces (bit-for-bit)', eq(recomputed, sealed.decision))`; `verify-real-eval` re-runs BOTH solvers on the sealed systems; `verify-plateau` recomputes the plateau detector). Reviewed + **executed locally: all three verifiers PASS (0 checks failed)**. Crucially, they treat an **honest null** as a first-class VERIFIED outcome — the plateau verifier PASSES with `promotionRate=0`. The README also polices its own claims ("a single-round proof-of-mechanism… NOT flywheel proof… do not use its synthetic promotion as marketing evidence") — the exact SYNTHETIC-vs-real discipline this series enforces.

**(b) A bug that discipline would have caught.** The budgeted live SWE-bench run (D1-S4) produced an **honest null**: the cheap model (glm-5.2) resolved `1/25` on SWE-bench-Lite, the flywheel found **no compounding lift (0 promotions)**, so the chain is just the immutable gen-0 root. `verifyReplayBundle` returned **FAIL** on it — a *valid, replayable* result was reported as an *invalid bundle*.

Root cause (`packages/flywheel/src/replay.ts`):

```ts
const promos = chain.filter((c) => c.verdict !== 'ROOT');
const allPromoted = promos.length > 0 && promos.every((c) => c.verdict === 'PROMOTED'); // BUG
```

The `promos.length > 0 &&` guard requires **≥1 promotion** for a bundle to verify. But a 0-promotion run (the flywheel honestly found nothing to promote — common with a weak model or a saturated policy) is a legitimate, signed, reconstructable result. The check's intent — "no rejected node smuggled into the promoted chain" — is satisfied **vacuously** by an empty non-root set.

## 2. Decision

1. **Honest-null runs are VALID and must replay-PASS.** Fixed the gate: `allPromoted = promos.every((c) => c.verdict === 'PROMOTED')` (vacuously true for a root-only chain). A run that produces zero verified improvements is a real, replayable outcome — not a broken bundle. Regression tests pin both directions: a root-only chain PASSES; a chain with a smuggled non-`PROMOTED` commit still FAILS. Shipped in `@metaharness/flywheel` **0.1.2**.

2. **Adopt the re-executing-verifier discipline as the metaharness standard** (from PR #64, forward plan): a replay verifier should not merely check that a *signed decision* is well-formed — it should **RE-RUN the gate function on the sealed scores and assert the recorded verdict reproduces bit-for-bit**. Today `verifyReplayBundle` verifies (receipts ∧ reaches-root ∧ contiguous-parents ∧ all-promoted ∧ gate-fingerprint) but cannot re-run `meetsPromotionRule` because a `LineageCommit` does not carry the baseline+candidate `Score`. The enhancement: **store `baselineScore` + `candidateScore` on each `LineageCommit`**, and add a `gateReExecutes` check to `verifyReplayBundle` that recomputes `promotionRule({baseline, candidate})` and asserts `promote === (verdict === 'PROMOTED')` for every commit. This closes the gap between "a signature over a claimed verdict" and "the verdict is what the frozen gate actually decides" — catching a signed-but-wrong promotion, which the current fingerprint check cannot.

## 3. Consequences

- **Correctness:** the D1-S4 honest-null bundle now verifies (`pass: true`). Every future weak/plateaued run replays honestly instead of masquerading as broken — which matters precisely because we must be able to publish negatives (a weak cheap model resolving `1/25` is a real, signed result, not a bug).
- **Trust model strengthened (forward):** re-executing the gate on sealed scores means an external reviewer trusts *the gate re-run*, not *our logged verdict* — the ADR-249/PR#64 "trust none of the logs" property, applied to promotion decisions.
- **Scope-honesty preserved:** this ADR does not change `meetsPromotionRule` (still frozen); it makes the *verifier* stricter and the *null case* honest.
- **Follow-up:** bump `LineageCommit` (minor, additive `baselineScore?`/`candidateScore?`) + wire the `gateReExecutes` check; republish flywheel; and — separately — the D1-S4 run itself needs a stronger solver or more instances before it is domain *evidence* (the `$0.0086` spend shows the cheap solver barely executed; this is an honest null, not a proof).
