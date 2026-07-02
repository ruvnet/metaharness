# ADR-0005: WASM bindings and Web UI architecture

- Status: Accepted
- Date: 2026-07-02

## Context

The browser deployment must offer WebGPU acceleration where available, a CPU
fallback everywhere, and a usable demo UI (upload, webcam, 1:1 comparison)
— without turning rvFACE into a JS project. Weights arrive over HTTP, so the
wasm module cannot assume a filesystem.

## Decision

### `rvface-wasm` (bindings)

- `wasm-bindgen` + `wasm-pack` (`--target web`), built from the same
  `rvface-core`/`rvface-models` crates as native.
- API surface (JS-facing, all data as typed arrays — no serde round-trips
  for pixels):
  - `RvFace.new(detectorWeights: Uint8Array, landmarkWeights: Uint8Array, embedderWeights: Uint8Array, backend: "cpu" | "webgpu") → Promise<RvFace>`
  - `detect(rgba: Uint8Array, width, height) → Float32Array` (packed
    `[x1,y1,x2,y2,score] × N`)
  - `analyze(rgba, width, height, maxFaces) → JsValue` (boxes, landmarks,
    pose, embeddings; one struct, serialized once)
  - `similarity(f1: Float32Array, f2: Float32Array) → number` (upstream
    0–100 scale)
- Backend selection: `"webgpu"` initializes the Burn wgpu backend on the
  browser's WebGPU adapter (async); on failure the constructor **falls back
  to CPU and reports which backend is live** — the caller never hard-fails
  for lack of GPU.
- **Single-threaded MVP.** No SharedArrayBuffer/threads, so the demo needs
  no COOP/COEP headers and works on plain static hosting (e.g. GitHub
  Pages). Rayon-in-wasm is a future ADR if CPU throughput demands it.

### `web/` (UI)

- **Vite + TypeScript, no framework** — the UI is one page (drag-drop /
  webcam, canvas overlay of boxes+landmarks+pose, two-slot face compare
  with score gauge and the upstream threshold-75 verdict, backend toggle
  with live FPS/latency readout). A component framework adds nothing here.
- Weights are served from `web/public/models/` (developer places converted
  safetensors there via `tools/`; git-ignored) and fetched with progress UI;
  `navigator.gpu` feature-detect preselects the backend toggle.
- Camera frames go `video → offscreen canvas → getImageData → Uint8Array`,
  reusing one buffer per frame to avoid GC pressure.

## Consequences

- The whole browser artifact is: one `.wasm` + tiny JS glue + static assets
  + weight files; deployable on any static host.
- Two wasm builds are avoided: one binary carries both backends; the wgpu
  path compiles in but activates only when requested/available. If binary
  size becomes a problem, splitting per-backend builds is the first lever
  (ADR-0007 territory, see budget in ADR-0006).
- Embeddings crossing the JS boundary as `Float32Array` keeps the door open
  for callers persisting templates (e.g. IndexedDB face gallery) without
  new binding work.
