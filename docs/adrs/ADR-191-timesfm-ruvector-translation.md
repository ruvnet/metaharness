# ADR-191 — TimesFM → `ruvector` translation (candle) via chunked iterative synthesis

**Status:** ✅ IMPLEMENTED + VALIDATED (2026-06-24) — all 5 phases done: crate (RuVector PR #603); weight-parity PASS (max-abs-diff 8.58e-6 vs PyTorch ref, real 200M weights); benchmark 45 ms/forecast (ruvultra 32t) / 168 ms (e2-std-4 4t), 24/24 finite; Darwin predictive-pruning integration (PRUNE/CONTINUE correct); 24-case GCP test (VM deleted, <$0.10). Honest open items: (a) prune absolute-plateau forecast biased high on short curves — decision rides robust *relative* ordering + the already-viable guard (documented in prune.rs); (b) perf numbers are baseline candle-CPU — NOT yet optimized (levers: KV-cache for autoregressive decode, MKL/SIMD accel features). The paid auto-synthesis pipeline remains future work.
**Date:** 2026-06-24
**Related:** ADR-189 (Chebyshev temperature — zero-temp for tensor-math generation), ADR-185 (tiered routing economics), `crates/poker-darwin` (candle/Rust validation), ruvnet/RuVector

---

## Context

`google-research/timesfm` is a decoder-only, patched time-series **foundation model** (zero-shot forecasting). Porting its
inference path to native **Rust/`candle`** lets RuVector (a) produce temporal embeddings directly inside the HNSW graph
and (b) run zero-shot forecasting with no Python microservice tax.

The SWE-bench / FUGU `xcascade` pipeline is tuned for **localize-and-patch within a known repo** — the opposite of
**monolithic greenfield translation** (Python/JAX → Rust/candle). A naive "port this repo" prompt collapses the context
window, hallucinates invalid candle tensor math (sparse training signal), and burns the Opus tax on immediate
empty-patch escalations. To use Metaharness for greenfield translation without breaking the cost-Pareto physics we must
**invert the dynamic**: instead of the agent localizing, *we act as the compiler*, feeding strictly bounded sequential
generation tasks ("chunked iterative synthesis").

### Freeze reconciliation (important)
The standing **spend freeze is on paid OpenRouter SWE-bench solver runs** (provisioning xcascade/cascade VMs). This ADR
is executed as **direct, free engineering** (Claude Code authoring Rust + verifying with `cargo`), which spends **$0**
OpenRouter and does not touch the committed n=300 VMs. The *automated* chunked-synthesis pipeline (driving the paid
xcascade tiers, table below) is the part that stays blocked until the freeze lifts; the **artifact** (the crate + the
harness) is built now by hand.

---

## Decision

Port TimesFM inference to a new `candle` crate in **ruvnet/RuVector** (`crates/timesfm`), plus a **chunked-synthesis
harness** in this repo that can later drive the port automatically through the tiered economics. Build it in the strict
sequence below so each chunk maps to a bounded, verifiable unit.

### Target architecture
1. **Core (Rust/candle):** decoder-only transformer blocks (`candle-core` + `candle-nn`) — input patch embedding,
   residual MLP, multi-head attention, output patch projection.
2. **Bridge:** a Python script that maps Google's HF `.safetensors` keys → the Rust struct/param hierarchy.
3. **Integration:** an adapter exposing pooled hidden states as dense vectors for `ruvector` ingestion + the
   autoregressive head for forecasting.

### Execution menu (chunked synthesis — routing is for the FUTURE paid pipeline)
| Phase | Module | Tier (future auto-run) | Effort | Status (this ADR, direct build) |
|---|---|---|---|---|
| 1 | Scaffolding & structs (config, module traits, no tensor math) | Economy (DeepSeek/GLM) | S | direct build |
| 2 | Weight-conversion script (HF safetensors → Rust keys) | Economy | S | direct build |
| 3 | Core tensor math (attention, patching, decoder forward) | Performance (zero-temp, Opus on empties) | L | direct build + **mandatory dimensional unit tests** |
| 4 | `ruvector` integration adapter (candle tensors → HNSW) | Balanced (xcascade) | M | direct build |

### Phase-3 discipline (the bottleneck — applies whether hand- or agent-built)
1. **Pre-seed context** with the exact candle ops needed (broadcasting, `transpose`/`reshape`/`narrow`/`matmul`/`contiguous`).
2. **Zero temperature** for `<patch>` generation (ADR-189) — no creative sampling while aligning matrix dims.
3. **Tests first:** write a Rust unit test with dummy `[B, T, N]` tensors *before* the forward pass, so the evaluator has
   a deterministic hook to catch dimensionality panics and retry. Every module ships a shape test.

---

## Consequences
- **Capability:** native zero-shot time-series forecasting + temporal graph embeddings for RuVector, no Python tax.
- **Metaharness stress test:** validates whether the empty-patch cascade economics survive high-density greenfield
  synthesis (the future auto-pipeline) — turning Metaharness from "bug fixer" into "cross-language compiler".
- **Deliverables:** (a) `crates/timesfm` PR to ruvnet/RuVector (builds + shape-tested), (b) the weight-bridge script,
  (c) the chunked-synthesis harness in this repo. Real weight-parity validation against the Python reference is flagged
  explicitly where not yet done — never claimed if unverified.
