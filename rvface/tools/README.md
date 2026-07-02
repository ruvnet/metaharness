# rvFACE tools (Python)

Host-side tooling; never shipped. Requires Python ≥ 3.10.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

| Script | Purpose |
|---|---|
| `fetch_and_convert.py` | Download published weights (detector `version-slim-320.pth`, cunjian 68-pt landmark checkpoint), convert everything to safetensors with canonical tensor names into `../models/`. Accepts `--irn50 path/to/irn50_pytorch.npy` if you have upstream's unpublished embedder weights. |
| `gen_fixtures.py` | Run the upstream PyTorch reference nets (real detector weights + seeded random weights for all three architectures) on fixed inputs; emit golden input/output fixtures for the Rust parity tests (`fixtures/`). |

Canonical tensor-name mapping is documented in `naming.md` once conversion
lands (task #4).
