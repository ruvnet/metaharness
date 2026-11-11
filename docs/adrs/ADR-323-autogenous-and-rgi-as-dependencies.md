# ADR-323: Autogenous as a real dependency of `@metaharness/autogenous`; rGi not added

**Status**: Accepted (implemented)
**Date**: 2026-11-11
**Project**: `ruvnet/metaharness`
**Related**: ADR-277 (Autogenous adapter), ADR-150; Autogenous ADR-392, ADR-396, ADR-401

## Context

The owner asked for Autogenous (`ruvnet/autogenous`) and rGi (`ruvnet/rGi`) to become dependencies of MetaHarness.

`@metaharness/autogenous` (ADR-277) reached Autogenous only by copying it. `genome.ts` hard-coded radio-moe's `CEILINGS`, its default independence weights and the frozen `sameAccuracyBand`. `gate.ts` copied `PROMOTION_MARGIN` and re-derived the `Better ∧ Safe ∧ Authorized ∧ Reversible` predicate. `authorized` was a boolean the caller supplied. No Autogenous code ran.

Autogenous now publishes two npm packages from its own repository:

- `radio-moe`: the governed mesh, including `CEILINGS`, `DEFAULT_INDEPENDENCE_WEIGHTS`, `PROMOTION_MARGIN`, `evaluate` (exported as `evaluateMeshParams`) and `promoteAuthorized`.
- `autogenous` (new, 0.1.0): the `agl-types` Rust crate compiled to WebAssembly. It provides `Mutation::admissible`, scope authority and the hard gates.

WebAssembly was chosen over napi, so the package ships no arch-specific binary and no glibc floor.

rGi publishes nothing. Its reusable piece is `rgi-core::evaluate`, a pre-dispatch check over a capability allowlist, a stop flag, a confidence floor and an integer-micros budget. Nothing in MetaHarness calls such a check:

- `HarnessKernel` gates on `PolicyGate` rules before dispatch, and on cost after execution, in float USD.
- `horizon` classifies commands in its own Rust core.

The dependency runs the other way: rGi's `src/adapters/metaharness.ts` consumes the MetaHarness SDK `ToolDef`.

## Decision

1. `@metaharness/autogenous` depends on `autogenous@0.1.0` and `radio-moe@0.3.1`, both pinned exactly, as `dependencies`. They are core to that package.
2. The copied constants are replaced with imports. In `genome.ts`, `AUTOGENOUS_CEILINGS` is `CEILINGS` itself and the root genome comes from `DEFAULT_INDEPENDENCE_WEIGHTS`. In `gate.ts`, `AUTOGENOUS_PROMOTION_MARGIN` is `PROMOTION_MARGIN` and the four-conjunct core is `promoteAuthorized()`.
3. `makeAutogenousEvaluator` runs AGL admission on every candidate after the benchmark (`src/admission.ts`, `admitAutogenousPolicy`):
   - The candidate is a `routing_budget` mutation of a parent genome.
   - It requests the scope's minimum authority, read from `scopePolicy`.
   - It must preserve the invariants `policy_surface_bounded` and `same_accuracy_band_frozen`.
   - Its rollback target is the parent only when the benchmark reports the parent as reversible. Otherwise AGL refuses with `no_rollback`.

   A refusal withdraws `authorized` (it can only narrow it), is recorded on the score as `aglAdmission`, and is reported by the gate as `agl_admission_refused:<reason>`.

   **Limits of this check.** With the default parent (`radioMoeParentGenome()`), AGL's verdict is a function of the adapter's own invariant flags and the benchmark's `reversible`. The parent's `hash` and `constitution` are adapter-local labels, not content hashes. AGL makes an independent authority decision only when the host passes its real genome as `admission.parent`; for example, a ceiling below `auto_reversible` is refused with `authority_expansion`. The de-duplication in this ADR comes from `radio-moe`. `autogenous` adds typed, host-parameterised admission.
4. `projectAutogenousScore` maps `topicRatio = +Infinity` to `Number.MAX_VALUE`. This is what radio-moe's real `evaluate()` returns for a perfectly separated topic. Before this change, every real radio-moe result was marked as regressed, and the flywheel could not sign it, because signed receipts reject non-finite numbers. NaN and -Infinity are still regressions.
5. rGi is **not** added. Adding it would mean inventing a new pre-dispatch admission feature only to create the dependency edge. Files checked for a check that `rgi_core::evaluate` could replace:
   - `harness/src/kernel.ts` and `harness/src/safety.ts`: rule-based `PolicyGate` plus post-hoc USD gates.
   - `horizon/src/guard.ts`: a shell-command classifier in Rust.
   - `avo/src/policy.ts`: action-kind envelope with a float risk budget and path/command regexes.
   - `avo/src/flywheelGate.ts`: receipt-signer allowlist.
   - `agntcy/src/index.ts`: compiles an envelope and explicitly never enforces it.
   - `flywheel/src/budget.ts`: durable call-slot charging.

   None is a capability-allowlist plus stop plus confidence plus integer-budget admission. If the owner wants that feature, the seam is a `PolicyRule` in `@metaharness/harness` backed by a published `rgi-wasm` package, declared as an optional dependency with a fail-closed fallback. That would need its own ADR.

## Changed call sites

- `packages/autogenous/src/genome.ts`: `AUTOGENOUS_CEILINGS`, `FROZEN_SAME_ACCURACY_BAND`, `rootGenome`, and every clamp bound.
- `packages/autogenous/src/gate.ts`: `AUTOGENOUS_PROMOTION_MARGIN`, and `autogenousPromotionRule` now uses `promoteAuthorized`.
- `packages/autogenous/src/evaluator.ts`: `makeAutogenousEvaluator(runBench, { admission })`.
- `packages/autogenous/src/admission.ts` (new): `admitAutogenousPolicy`, `policyMutation`, `radioMoeParentGenome`.
- `packages/autogenous/src/score.ts`: `aglAdmission` on the score, and the `topicRatio` mapping.

## Consequences

- One source of truth for the radio-moe constants. A change upstream reaches this adapter through a version bump, not a manual copy.
- The adapter still never applies a champion and still requires an injected benchmark (ADR-277). Admission only narrows what can be promoted.
- `@metaharness/autogenous` pulls in `radio-moe`, which depends on `@metaharness/radio`, and a 185 KB wasm module. The install is about 1.6 MB.

## Verification

`__tests__/autogenous-upstream.test.ts` imports the real `autogenous` and `radio-moe` packages. Nothing is mocked. It checks four things:

- The constants are identical to radio-moe's.
- radio-moe's `evaluate()` scores the reference champion at separation 1.25 against the root's 0.6875, and the champion is promoted through `promoteAuthorized`.
- A policy that unfreezes `sameAccuracyBand` is refused by AGL with `invariant_regressed`, and the gate blocks it.
- A parent genome whose ceiling is below `auto_reversible` is refused with `authority_expansion`, and an irreversible candidate is refused with `no_rollback`.
- Two flywheel generations on radio-moe fitness produce a replay bundle that verifies, including after a JSON round trip.
