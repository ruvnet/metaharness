# models/

Converted safetensors weights land here (git-ignored). Produce them with
`python3 tools/fetch_and_convert.py`.

Provenance and licensing per docs/adrs/0003:

| File | Source | License |
|---|---|---|
| `detector-slim320.safetensors` | Faceplugin SDK `version-slim-320.pth` (originally Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) | MIT |
| `landmark-mfn68.safetensors` | cunjian/pytorch_face_landmark MobileFaceNet checkpoint | MIT lineage |
| `embedder-*.safetensors` | openly licensed ArcFace-style MobileFaceNet checkpoint (exact source pinned by the conversion script) | see script header |
| `embedder-irn50.safetensors` | optional — converted from user-supplied `irn50_pytorch.npy` (not published upstream) | n/a |

SHA-256 pins for downloaded originals are enforced by the script.
