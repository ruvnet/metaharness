# ADR-0006: Testing, validation, and optimization strategy

- Status: Accepted
- Date: 2026-07-02

## Context

"Ported and it compiles" is not "ported correctly". The reference
implementation is Python/PyTorch; the port must prove numerical parity
without committing hundred-megabyte weights, and must quantify performance
on both backends.

## Decision

### Three validation tiers

1. **Unit tests (pure Rust, `rvface-core`)** — priors generation (exact
   values for the 4420 slim-320 priors' count/corners), box decode round-
   trip, hard-NMS against hand-computed cases, IoU edge cases, affine
   sampling on synthetic gradients, similarity formula endpoints
   (`dot=1 → 100`, `dot=-1 → 0`).
2. **Golden-vector parity tests (`rvface-models`)** — `tools/gen_fixtures.py`
   runs the *upstream PyTorch modules verbatim* with (a) real detector
   weights and (b) **seeded random weights** for all three nets, on fixed
   inputs; it emits compact JSON fixtures (inputs, outputs, weight files as
   safetensors). Rust tests load the same weights and assert outputs match
   within `max|Δ| ≤ 1e-4` (fp32 conv reordering tolerance). Random-weight
   fixtures make architecture-parity testable in CI with no license or size
   burden (ADR-0003).
3. **End-to-end tests** — upstream's `test/1.jpg` / `test/2.png` through the
   full Rust pipeline: face found in each, 68 landmarks inside the box,
   alignment property (eyes at (44,48)/(84,48) ±1px), embeddings
   L2-normalized, similarity reproduces the Python pipeline's verdict with
   the same weights. CLI `rvface compare` is the harness.

### Performance & size

- **Criterion benchmarks** (native, per-stage: detect / landmarks / embed)
  gate regressions; results recorded in `docs/BENCHMARKS.md` per commit
  that touches models or core math.
- **Wasm budget**: ≤ 3.5 MB gzipped for the `.wasm` (excluding weights);
  enforced by a check script in `web/`. Levers in order: `opt-level`
  tuning, `wasm-opt -O2`, feature-pruning burn/wgpu, per-backend split
  builds.
- **Optimization order** (only with benchmarks in hand): release-profile
  tuning (fat LTO, 1 CGU) → buffer reuse in pre/post-processing (zero
  per-frame allocation) → backend-level (im2col vs direct conv choice is
  Burn's; we contribute shapes it likes, e.g. NCHW contiguity) → f16
  weights on wgpu → quantization (future ADR).

### Non-goals

- No training, no dataset-scale accuracy re-benchmarking (LFW etc.) — the
  port inherits the checkpoints' accuracy by construction once parity holds.

## Consequences

- Fixture JSON manifests are committed; the arrays/weights themselves are
  regenerated locally with `tools/gen_fixtures.py` (deterministic,
  byte-identical across runs — the IRN-50 random weights alone are 56 MB,
  so committing them is not viable). Parity tests skip gracefully when the
  fixture files are absent.
- Parity failures localize immediately: tier 1 → our math, tier 2 → a layer
  port, tier 3 → glue/preprocessing.
