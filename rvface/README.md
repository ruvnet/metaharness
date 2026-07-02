# rvFACE

**Rust + WebAssembly face recognition** — a complete port of the
[Faceplugin Open-Source-Face-Recognition-SDK](https://github.com/Faceplugin-ltd/Open-Source-Face-Recognition-SDK)
(Python/PyTorch) to Rust, running natively and in the browser on **WebGPU or CPU**, with a web UI.

![rvFACE web UI demo](docs/media/demo.gif)

| Analyze: detection · 68 landmarks · pose | 1:1 compare: score gauge · threshold-75 verdict |
|---|---|
| ![Analyze pane](docs/media/screenshot-analyze.png) | ![Compare pane](docs/media/screenshot-compare.png) |

## Pipeline

```
image ─► slim-320 SSD detector ─► 68-pt MobileFaceNet landmarks ─► head pose
                                        │
                                        ▼
                          eyes-level alignment (128×128)
                                        │
                                        ▼
                       embedding CNN ─► L2-normalized feature
                                        │
                                        ▼
                     similarity = (dot + 1) × 50   (match > 75)
```

## Workspace

| Path | What |
|---|---|
| `crates/rvface-core` | Framework-free pipeline math (priors, NMS, alignment, pose, similarity, image ops) |
| `crates/rvface-models` | [Burn](https://burn.dev) ports of the three CNNs (CPU: ndarray · WebGPU: wgpu) |
| `crates/rvface-cli` | Native CLI (`rvface detect`, `rvface compare`) |
| `crates/rvface-wasm` | Browser bindings (wasm-bindgen) |
| `web/` | Web UI (Vite + TS): upload/webcam, overlays, 1:1 compare, backend toggle |
| `tools/` | Python: weight conversion → safetensors, golden parity fixtures |
| `docs/adrs/` | Architecture decision records (start at [0001](docs/adrs/0001-project-scope-and-layout.md)) |

## Quick start

```bash
# native
cd rvface
python3 tools/fetch_and_convert.py          # download + convert weights → models/
cargo run -p rvface-cli --release -- compare a.jpg b.png

# browser
cd web && npm install && npm run dev        # weights served from web/public/models/
```

## Status

Actively being ported — see ADRs for scope and `docs/adrs/0003` for why some
upstream weights are substituted (upstream does not publish them all).
