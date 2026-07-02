# rvFACE tools (Python)

Host-side tooling; never shipped. Requires Python ≥ 3.10 and network access to
`raw.githubusercontent.com` (all downloads are SHA-256-pinned).

```bash
cd tools
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt        # torch CPU is enough:
# pip install torch --index-url https://download.pytorch.org/whl/cpu
```

Upstream reference sources are **downloaded at runtime** into the git-ignored
`tools/.cache/` — the upstream repo has no LICENSE file, so its `.py` files
are never vendored into this repository (ADR-0003).

## `fetch_and_convert.py`

```bash
python fetch_and_convert.py [--irn50 path/to/irn50_pytorch.npy]
```

Downloads the published weights (SHA-256 verified, cached in `.cache/`) and
converts them to safetensors in `../models/`, tensor keys = original PyTorch
`state_dict` keys (see `naming.md`). Each model gets a
`<name>.manifest.json` (committed) with source URL + pin, license notes,
exact preprocessing, architecture hyperparameters, and the full tensor list —
the Rust side builds models from these manifests.

| Output | Source |
|---|---|
| `models/detector-slim320.safetensors` | Faceplugin SDK `version-slim-320.pth` (Ultra-Light-Fast slim-320, MIT lineage) |
| `models/landmark-mfn68.safetensors` | cunjian/pytorch_face_landmark 68-pt MobileFaceNet checkpoint (112×112) |
| `models/embedder-mfn.safetensors` | Xiaoccer/MobileFaceNet_Pytorch `model/best/068.ckpt` (112×96 RGB, 128-d) |
| `models/embedder-irn50.safetensors` | only with `--irn50`: user-supplied upstream `irn50_pytorch.npy` |

## `gen_fixtures.py`

```bash
python gen_fixtures.py
```

Runs the upstream PyTorch reference nets verbatim (imported from `.cache/`)
on fixed pseudo-random inputs and writes golden parity fixtures to
`fixtures/` for the Rust tests (ADR-0006 tier 2). Deterministic: re-running
reproduces byte-identical files.

| Fixture | Net / weights |
|---|---|
| `detector-real` | slim-320 SSD, real weights; pre-NMS softmaxed confidences + decoded corner boxes |
| `detector-rand` | same net, seeded random weights (seed 1234) |
| `landmark64-rand` | upstream 64×64-gray MobileFaceNet-136, seeded random weights (5678) |
| `landmark-cunjian` | cunjian 112×112 MobileFaceNet-136, real checkpoint (+ `landmark-cunjian.notes.md` documenting the reference preprocessing) |
| `irn50-rand` | upstream IRN-50 embedder, seeded random weights (9012) |
| `embedder-mfn-real` | Xiaoccer 112×96 MobileFaceNet-128, real checkpoint |

Arrays are float32 `.npz` (input + outputs), synthetic weights are
`.safetensors`, each fixture has a JSON manifest, and `fixtures/INDEX.json`
lists them all. `.npz`/`.safetensors` are git-ignored (regenerate locally);
the JSON manifests and notes are committed. Run `fetch_and_convert.py` first
if you want the `real:` fixtures' weight references to resolve.

Tensor-name convention, manifest schemas, the deterministic input formulas,
and the `randn-kaiming-v1` random-weight recipe are documented in
[`naming.md`](naming.md).
