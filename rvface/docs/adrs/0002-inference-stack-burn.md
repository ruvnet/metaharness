# ADR-0002: Burn as the inference stack (WebGPU + CPU, native + WASM)

- Status: Accepted
- Date: 2026-07-02

## Context

The port must run the three CNNs (SSD detector, MobileFaceNet landmarks,
IRN-50 embedder) in four execution contexts from one codebase:

|  | CPU | WebGPU |
|---|---|---|
| **native** | dev/CI/CLI | benchmarking |
| **wasm (browser)** | universal fallback | primary "fast" path |

Candidates considered:

- **Burn** — pure-Rust DL framework; model code is generic over a `Backend`
  trait; `burn-ndarray` (CPU, compiles to `wasm32-unknown-unknown`) and
  `burn-wgpu` (WebGPU via `wgpu`, works native and in-browser) are both
  first-class; official browser demos exist.
- **candle** — good CPU/WASM story, but its WebGPU backend is immature and
  not a supported target for arbitrary models.
- **tract** — excellent ONNX CPU inference, WASM-capable, but **no GPU
  backend at all**; would satisfy only half the requirement.
- **ort (ONNX Runtime)** — native C++ dependency; browser deployment means
  shipping Microsoft's prebuilt onnxruntime-web instead of our own Rust
  artifact; not a *port to Rust* in any meaningful sense.
- **Hand-rolled kernels** — maximal control, but re-implementing conv2d /
  depthwise / batchnorm with acceptable performance on both CPU and WebGPU
  is its own project and unjustifiable when Burn provides audited kernels.

## Decision

- Use **Burn 0.18.0**, pinned. Model definitions in `rvface-models` are
  written once, generic over `B: Backend`; concrete backends:
  - `burn-ndarray` for CPU (native + wasm),
  - `burn-wgpu` for WebGPU (native + wasm).
- Backend selection is a **runtime decision in the host layer**
  (CLI flag / web UI toggle with feature-detect fallback), compiled in via
  cargo features `cpu` (default) and `webgpu`.
- Weights load from **safetensors** buffers (ADR-0003) through a small
  loader in `rvface-models` that maps canonical tensor names to module
  parameters; no dependency on `burn-import`'s PyTorch reader (keeps the
  pickle format out of the trust boundary and works identically in wasm,
  where there is no filesystem).

## Consequences

- One model implementation serves all four contexts; parity tests (ADR-0006)
  run on the ndarray backend in CI and are expected to hold on wgpu within
  float tolerance.
- Burn 0.18 pins `wgpu` at a version whose WebGPU support requires a
  browser with the WebGPU API (Chromium ≥ 113, Firefox ≥ 141); the UI must
  therefore feature-detect and fall back to CPU (ADR-0005).
- Upgrading Burn (0.19+, e.g. for CubeCL improvements) is deliberate,
  isolated churn inside `rvface-models` only.
- Burn brings a large transitive dependency tree; `rvface-core` stays
  framework-free so the exactness-critical math is auditable and fast to
  test in isolation.
