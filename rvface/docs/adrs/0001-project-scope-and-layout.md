# ADR-0001: rvFACE project scope and repository layout

- Status: Accepted
- Date: 2026-07-02

## Context

rvFACE is a complete port of the
[Faceplugin Open-Source-Face-Recognition-SDK](https://github.com/Faceplugin-ltd/Open-Source-Face-Recognition-SDK)
(Python / PyTorch / OpenCV) to Rust, targeting both native execution and
WebAssembly in the browser with a WebGPU or CPU compute backend, plus a web UI.

The upstream SDK pipeline (from `run.py`) is:

1. **Face detection** — Ultra-Light-Fast-Generic-Face-Detector "slim-320"
   (`Mb_Tiny` backbone + SSD heads, ~1.06 MB weights, input 320×240 RGB,
   mean 127 / std 128).
2. **68-point landmark extraction** — a MobileFaceNet variant
   (grayscale crop, 136 regression outputs).
3. **Head pose** — solved from the 68 landmarks (`face_pose/GetPose.py`).
4. **Face alignment** — `align_vertical(...)` similarity-transform crop to
   128×128 (via a `face_util` native helper).
5. **Feature embedding** — "IRN-50" Inception-ResNet CNN
   (`irn50_pytorch.py`, weights from `irn50_pytorch.npy`), input 128×128 RGB
   scaled by 1/256, output L2-normalized embedding.
6. **Similarity** — `score = (dot(f1, f2) + 1) * 50`, match threshold 75.

An audit of the upstream repository (2026-07-02, 5 commits, no LICENSE file)
found it is **not self-contained**: `face_pose/`, `face_util/`,
`face_landmark/GetLandmark.py`, the landmark weights, and
`face_feature/irn50_pytorch.npy` are referenced by `run.py` but absent.
Only the detector ships with both code and weights. This materially shapes
the porting strategy (see ADR-0003 and ADR-0004).

## Decision

- rvFACE lives as a **self-contained Cargo workspace** under `rvface/` in
  this repository (branch requirement of the session). Nothing in it depends
  on the parent `metaharness` workspace, so the directory can later be
  extracted 1:1 into its own repository.
- Workspace layout:

  | Path | Purpose |
  |---|---|
  | `crates/rvface-core` | Framework-free pipeline math: SSD priors, box decode, NMS, image ops (resize/color/normalize), alignment transform, head pose, similarity. No ML-framework dependency, no OpenCV. |
  | `crates/rvface-models` | Neural network ports (detector, landmark, embedder) on the Burn framework, generic over backend; safetensors weight loading. |
  | `crates/rvface-cli` | Native CLI: detect / compare / benchmark on image files. |
  | `crates/rvface-wasm` | `wasm-bindgen` bindings exposing the pipeline to JS. |
  | `web/` | Web UI (Vite + TypeScript): upload/webcam, overlay, 1:1 compare, WebGPU/CPU toggle. |
  | `tools/` | Python tooling: weight download/conversion to safetensors, golden-fixture generation. |
  | `docs/adrs/` | These records. |
  | `models/` | Local model artifacts (git-ignored; produced by `tools/`). |

- The crate split keeps everything that must be **numerically identical** to
  upstream (core math) testable without heavy dependencies, and isolates the
  ML framework choice (ADR-0002) behind one crate boundary.

## Consequences

- `rvface/` builds independently (`cargo build` inside `rvface/`); the parent
  workspace's member list is untouched.
- Model weights are never committed to git (size + licensing, ADR-0003);
  CI-style validation uses deterministic random-weight fixtures instead.
