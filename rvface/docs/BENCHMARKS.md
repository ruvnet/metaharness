# rvFACE benchmarks

Recorded per ADR-0006. Hardware: 4-core x86_64 Linux container (this repo's
dev environment); numbers are indicative, not lab-grade. Reproduce with
`cargo bench -p rvface-cli` (native) and the web UI's latency readout (wasm).

## Native, CPU (Burn NdArray, release, criterion)

860×520 input, 1 face, MobileFaceNet embedder:

| Stage | before denormal fix | after | change |
|---|---|---|---|
| `detect` (full 320×240 SSD + postprocess) | 43.6 ms | **34.2 ms** | −19% |
| `analyze` (detect + landmarks + pose + align + embed) | 886 ms | **176 ms** | **−80%** |
| `similarity` (256/128-d dot) | 60 ns | 58 ns | — |

## Browser, wasm (single-thread CPU backend + SIMD128, Chromium)

Same image via the web UI (`analyze()` end-to-end incl. JS boundary):

| Build | per-analyze latency |
|---|---|
| no SIMD, denormal weights | ~4.3–5.0 s |
| SIMD128, denormal weights | ~1.9–2.3 s |
| **SIMD128 + denormal flush (shipped)** | **~0.44–0.79 s** |

WebGPU: compiled into the shipped binary; headless Chromium in this
environment exposes no adapter, so only the CPU-fallback path could be
measured here. Expect substantially lower latency on real WebGPU hardware.

## The denormal-weight fix

The cunjian landmark checkpoint stores **75% of its weights as denormal
floats** (773,548 of 1,026,898 — weight-decay artifacts ~1e-39). Denormal
arithmetic takes a ~100× microcode penalty on x86, natively and in wasm
(where FTZ/DAZ cannot be enabled at all). `Weights::from_safetensors`
flushes `|w| < 1e-30` to zero at load time; the maximum contribution of such
a weight to any activation is ~1e-27, twenty-three orders of magnitude
below the fp32 parity tolerance (1e-4). All 61 tests, including the six
PyTorch golden-parity fixtures, pass unchanged.

## Wasm size (budget ≤ 3.5 MB gzipped, ADR-0006)

| | raw | gzip |
|---|---|---|
| shipped (SIMD128, webgpu+cpu, wasm-opt -O2) | 6.9 MB | **1.42 MB** |

≈39% of budget.
