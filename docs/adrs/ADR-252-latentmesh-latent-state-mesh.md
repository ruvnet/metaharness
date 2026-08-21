# ADR-252: LatentMesh — causally-verified latent-state communication between agents

**Status**: Proposed (external research prototype adopted as a planned integration; no code in this repo yet)
**Date**: 2026-08-21
**Project**: `ruvnet/metaharness`
**Related**: ADR-243 (RVF metaharness adapter), ADR-245 (Horizon durable execution), ADR-250 (SOTA-proof ladder), ADR-251 (`@metaharness/avo` governed autonomous variation)
**External grounding**: [ruvnet/LatentMesh](https://github.com/ruvnet/LatentMesh) (Rust 1.77+, MIT OR Apache-2.0)

## Context

Multi-agent harnesses in this repo communicate exclusively through text:
Agent A serializes its conclusion into tokens, Agent B re-parses them. Every
hop pays full serialization/deserialization cost and loses the internal
state that produced the conclusion.

LatentMesh is a research prototype that transfers internal hidden states
directly through aligned embedding spaces instead. Its components:

| Crate | Role |
|---|---|
| `latentmesh-core` | `LatentFrame` packets (F32/F16/Int8 encodings), provenance, authority levels (ObserveOnly → ActionInfluencing) |
| `latentmesh-align` | Training-free orthogonal alignment (Procrustes/SVD), O(d²n) |
| `latentmesh-gate` | Admission gate: signature, authority, provenance, risk thresholds; five-control permutation tests |
| `latentmesh-bench` | Measured wire bytes and alignment wall-clock |

The design principle that makes it compatible with this repo's governance
model: **no edge gains execution authority by default**. Every candidate
connection must beat five control conditions (null state, random noise,
mismatched task, self-generated state, text-equivalent baseline) with
statistically significant performance gains before it can influence
behavior. That is the same fail-closed, evidence-before-authority shape as
ADR-251's capability policy and ADR-250's proof ladder.

Honest status of the upstream prototype (as published): packet types,
alignment math, causal statistics, and the admission gate are implemented,
deterministic, and runnable offline. NOT shipped upstream: live open-weight
model integration, streaming (MidStream/RuVector), topology evolution
(named as a MetaHarness integration), and federated coordination (Radio).
Its acceptance test (three heterogeneous models, 25% latency/token
improvement, 80% edge survival) has not run. Claimed measured numbers are
mechanism-level only: ~964× alignment speedup on 4096-dim vectors
(2792 ms → 161.8 ms) and 64.1–256 KiB wire cost per 16×4096-dim batch.

## Decision

Adopt LatentMesh as the planned latent-state communication layer for
MetaHarness multi-agent topologies, integrated under this repo's existing
governance seams rather than as a parallel authority system:

1. **Edge authority is a policy object, not a transport property.** A
   LatentMesh edge's authority level maps onto the ADR-251
   `CapabilityPolicy` model: `ObserveOnly` edges are always admissible;
   `ActionInfluencing` edges require the five-control causal verification
   *and* a signed receipt trail, exactly as AVO actions require policy
   authorization plus signed `ActionReceipt`s.
2. **Topology evolution goes through Darwin.** Which edges exist, their
   encoding (F32/F16/Int8), and their authority ceiling become an evolvable
   genome surface for `@metaharness/darwin` — evaluated, promoted, and
   rolled back by the same archive/budget/promotion machinery as every
   other surface. LatentMesh's own edge-survival statistic becomes an
   evaluator input, not a self-certifying promotion.
3. **Evidence rides RVF.** `LatentFrame` provenance chains and gate
   verdicts are persisted as RVF artifacts (ADR-243) so a topology's causal
   audit is replayable offline, matching the ADR-251 replay-proof pattern.
4. **Claims are laddered.** Per ADR-250, the upstream mechanism-level
   results (alignment speedup, wire cost, deterministic gate) sit at rung 1–2.
   No latency/token-improvement claim is made until the live acceptance
   test (three heterogeneous models) runs under a frozen gate — rung 3+.

## Integration seams (planned, in order)

1. FFI/NAPI or subprocess bridge exposing `latentmesh-gate` verdicts to the
   TypeScript harness (Rust stays the implementation language — no port).
2. `@metaharness/darwin` genome surface `latentTopology` gated behind an
   opt-in flag, mirroring how `variationOperator` (ADR-251) is opt-in.
3. RVF persistence of frames + verdicts via the ADR-243 adapter.
4. Live acceptance run wired to the OpenRouter/GCP-secret evidence pattern
   established by `packages/avo/__tests__/openrouter-live.test.ts`.

## Consequences

- Latent communication enters the system only through the same
  evidence-before-authority gates the rest of MetaHarness already uses;
  a misaligned or adversarial edge defaults to no influence.
- Rust-side determinism (offline-runnable gate + alignment) means CI can
  verify the mechanism without model spend; only rung-3+ claims cost money.
- Until the bridge ships, this ADR is a boundary-setting document: any PR
  that wires latent frames into action selection without the five-control
  gate and signed receipts violates this decision.

## Ship gate (before Status moves to Accepted/Implemented)

1. Bridge crate builds in this repo's CI (deterministic tests only).
2. Gate verdicts replay byte-identically from RVF artifacts.
3. Darwin `latentTopology` surface rejects unverified-edge promotion in a
   deterministic test.
4. Live three-model acceptance run with signed receipts and preregistered
   thresholds (25% latency/token improvement, 80% edge survival) — or an
   honest null result recorded in this ADR.
