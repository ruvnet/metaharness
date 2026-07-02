# models/

Converted safetensors weights land here (git-ignored; the `*.manifest.json`
files are committed). Produce them with `python3 tools/fetch_and_convert.py`
(see `tools/README.md`). SHA-256 pins for the downloaded originals are
enforced by the script, and each manifest records source URL, pin, license
notes, exact preprocessing, and architecture hyperparameters.

Provenance and licensing per docs/adrs/0003:

| File | Source | License |
|---|---|---|
| `detector-slim320.safetensors` | Faceplugin SDK `version-slim-320.pth` (originally Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) | MIT |
| `landmark-mfn68.safetensors` | cunjian/pytorch_face_landmark `checkpoint/mobilefacenet_model_best.pth.tar` (68-pt MobileFaceNet, 112×112) | no LICENSE file upstream; MIT-lineage architecture; fetched at runtime, never redistributed |
| `embedder-mfn.safetensors` | Xiaoccer/MobileFaceNet_Pytorch `model/best/068.ckpt` (MobileFaceNet 112×96 RGB, 128-d, CASIA-WebFace) | no LICENSE file upstream; fetched at runtime, never redistributed |
| `embedder-irn50.safetensors` | optional — converted from user-supplied `irn50_pytorch.npy` via `--irn50` (not published upstream) | n/a |

Note: an Apache-2.0 alternative embedder exists (foamliu/MobileFaceNet
release asset `mobilefacenet_scripted.pt`) but GitHub release downloads are
not reachable from the build environment used to pin these sources; revisit
if that changes.
