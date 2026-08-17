# ADR-251: Autogenous as a governed MetaHarness flywheel adapter

**Status**: Accepted (implemented)
**Date**: 2026-08-17
**Updated**: 2026-08-17
**Project**: `ruvnet/metaharness`
**Related**: ADR-150, ADR-153, ADR-235; Autogenous ADR-392 and ADR-400

## Context

`ruvnet/autogenous` is a separate Rust workspace for governed evolutionary software. Its `packages/radio-moe` companion already has a removable in-repo flywheel and a reference MetaHarness bench. The integration contract says the source, fusion algorithm, signature/replay/sequence checks, fail-closed behavior, and hard gates are frozen. Only four independence penalties plus the quorum threshold are currently evolvable. The `sameAccuracyBand` penalty is explicitly excluded until it has a dedicated benchmark.

Copying radio-moe's evaluator into this repository would create two safety authorities. Treating Autogenous as a host or a vertical would also be the wrong boundary: it is neither an execution host nor generated content; it is an external governed control plane with a typed policy-evolution seam.

## Decision

Ship `packages/autogenous` as `@metaharness/autogenous`, a standalone adapter over `@metaharness/flywheel`.

1. The policy genome exposes exactly `sameProvider`, `sameArch`, `sameSize`, `sourceJaccard`, and `quorumThreshold`, clamped to radio-moe's constitutional ceilings.
2. `sameAccuracyBand` remains a compile-time frozen value and is absent from the flywheel mutation policy.
3. Evaluation requires an injected `AutogenousBenchRunner`; the package does not duplicate Autogenous' safety-critical evaluator.
4. The promotion rule is the Autogenous invariant `Better AND Safe AND Authorized AND Reversible`, plus no regression on correlated- or independent-error quality and no cost/anchor regression.
5. The adapter remains removable from Autogenous. It writes no runtime configuration and has no authority to apply a champion.

## Consequences

- Autogenous can use MetaHarness' signed lineage, replay bundles, and generic flywheel without moving its canonical AGL/runtime types into this repository.
- The package fails closed on unknown, malformed, or out-of-bounds policy fields.
- A real benchmark integration still belongs in Autogenous and is injected here. Tests use deterministic fixtures and make no live-performance claim.
- Adding another evolvable parameter requires an Autogenous benchmark and a follow-up decision; it is not unlocked by changing caller input.

## Verification

- Package unit tests cover the mutation allowlist, frozen parameter, bounds, injected evaluator, every promotion conjunct, and end-to-end flywheel receipts.
- Workspace build ordering places the adapter after `@metaharness/flywheel`.
