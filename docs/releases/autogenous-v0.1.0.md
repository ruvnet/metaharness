# @metaharness/autogenous 0.1.0: first release, on the real Autogenous packages

Package: `@metaharness/autogenous@0.1.0` only. This is its first npm release. Design: ADR-323.

## Dependencies

- `autogenous@0.1.0` (new; the Autogenous `agl-types` crate compiled to WebAssembly) and `radio-moe@0.3.1`. Both are exact pins in `dependencies`.

## Changed

- The adapter no longer copies radio-moe. `AUTOGENOUS_CEILINGS` is radio-moe's `CEILINGS`. The root genome comes from `DEFAULT_INDEPENDENCE_WEIGHTS`, and `AUTOGENOUS_PROMOTION_MARGIN` is `PROMOTION_MARGIN`.
- `autogenousPromotionRule` takes its `Better ∧ Safe ∧ Authorized ∧ Reversible` core from radio-moe's `promoteAuthorized()`.
- `makeAutogenousEvaluator` admits every candidate through AGL `Mutation::admissible` after the benchmark. The candidate is a `routing_budget` mutation, and it has a rollback target only if the benchmark reports it reversible. Hosts can pass their real genome as `admission.parent`. A refusal clears `authorized`, is kept on the score as `aglAdmission`, and is reported by the gate as `agl_admission_refused:<reason>`.

## Fixed

- `topicRatio = +Infinity`, which radio-moe's `evaluate()` returns on perfect topic separation, is mapped to `Number.MAX_VALUE`. Before, such a result was marked regressed and could not be signed into a flywheel receipt.

The README quickstart was run against the packed tarball in a clean directory. It prints separation 0.6875 -> 1.25, `{ admissible: true }` and `{ promote: true, reasons: [] }`. A policy that unfreezes `sameAccuracyBand` is refused with `invariant_regressed`.
