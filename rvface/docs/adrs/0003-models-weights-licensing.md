# ADR-0003: Model weights sourcing, conversion, and licensing

- Status: Accepted
- Date: 2026-07-02

## Context

The upstream repository publishes:

| Stage | Architecture code | Pretrained weights |
|---|---|---|
| Detector (slim-320 SSD) | ✅ `face_detect/vision/**` | ✅ `version-slim-320.pth` (1.06 MB) |
| Landmarks (MobileFaceNet-68, 64×64 gray, 136 out) | ✅ `face_landmark/MobileFaceNet.py` | ❌ not published |
| Embedder (IRN-50, 128×128 RGB) | ✅ `face_feature/irn50_pytorch.py` | ❌ `irn50_pytorch.npy` not published |
| Alignment / pose helpers | ❌ `face_util/`, `face_pose/` absent | — |

The upstream repo also has **no LICENSE file** (README badge says
"Open Source"). The detector code and weights originate from
[Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB)
(MIT). The landmark architecture matches
[cunjian/pytorch_face_landmark](https://github.com/cunjian/pytorch_face_landmark)
(MIT lineage), which *does* publish a compatible-family 68-point
MobileFaceNet checkpoint (112×112 RGB input variant).

## Decision

1. **Port all three architectures faithfully** in Burn, including IRN-50,
   so the port is complete with respect to everything upstream published.
2. **Architecture correctness is validated without pretrained weights**:
   `tools/` generates *deterministic random* weights per network, runs the
   PyTorch reference implementation, and emits golden input/output pairs;
   the Rust ports must reproduce them (ADR-0006). This decouples "is the
   port correct?" from "are the original weights available?".
3. **Runnable defaults** use openly obtainable weights:
   - Detector: upstream `version-slim-320.pth` (MIT lineage).
   - Landmarks: cunjian's 68-point MobileFaceNet checkpoint; the Rust
     MobileFaceNet is **parameterized** (input channels, spatial size, GDC
     kernel, output dim) so it expresses both the upstream 64×64-gray
     variant and the 112×112-RGB checkpoint variant.
   - Embedder: an openly licensed ArcFace-style MobileFaceNet embedding
     checkpoint (same parameterized architecture, 112×112 RGB); the IRN-50
     port remains available for users who possess `irn50_pytorch.npy`,
     which `tools/convert_weights.py` accepts as an optional input.
4. **Distribution format is safetensors**, produced by `tools/` from the
   original `.pth`/`.pth.tar`/`.npy` files with canonical, stable tensor
   names (documented in `tools/`). Weights are git-ignored and fetched or
   converted locally; the web UI loads them over HTTP at runtime.

## Consequences

- rvFACE works out of the box for detection + landmarks + alignment + pose,
  and for recognition with the substitute embedder; bit-parity with
  upstream's *unpublished* embedder deployment is impossible for anyone
  without `irn50_pytorch.npy`, and this is documented rather than hidden.
- Because the default landmark/embedder weights differ from upstream's
  private ones, the *pipeline semantics* (crop, normalization, similarity
  scale, threshold 75) are still ported exactly (ADR-0004), so scores stay
  in the upstream scale and a user-supplied IRN-50 drops in cleanly.
- No third-party weights enter this repository; licensing notes ship in
  `models/README.md` alongside download provenance and SHA-256 pins.
