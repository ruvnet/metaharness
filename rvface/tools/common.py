"""Shared helpers for rvFACE host-side tooling (fetch_and_convert.py, gen_fixtures.py).

Stdlib + torch/numpy/safetensors only.

Upstream reference sources are downloaded at runtime into ``tools/.cache/``
(git-ignored) because the upstream repository publishes no LICENSE file; we
never vendor its ``.py`` files into this repository (ADR-0003). Every download
is pinned by SHA-256; a mismatch aborts loudly.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import shutil
import subprocess
import sys
import types
import urllib.request
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
CACHE_DIR = TOOLS_DIR / ".cache"
SDK_DIR = CACHE_DIR / "sdk"
MODELS_DIR = TOOLS_DIR.parent / "models"
FIXTURES_DIR = TOOLS_DIR / "fixtures"

_SDK_RAW = "https://raw.githubusercontent.com/Faceplugin-ltd/Open-Source-Face-Recognition-SDK/main"
_CUNJIAN_RAW = "https://raw.githubusercontent.com/cunjian/pytorch_face_landmark/master"
_XIAOCCER_RAW = "https://raw.githubusercontent.com/Xiaoccer/MobileFaceNet_Pytorch/master"

# name -> (cache-relative path, url, sha256). Pins computed 2026-07-02.
FILES: dict[str, tuple[str, str, str]] = {
    # -- weights / test images ------------------------------------------------
    "detector.pth": (
        "version-slim-320.pth",
        f"{_SDK_RAW}/face_detect/models/pretrained/version-slim-320.pth",
        "cd24abce45da5dbc7cfd8167cd3d5f955382dfc9d9ae9459f0026abd3c2e38a4",
    ),
    "landmark.pth.tar": (
        "mobilefacenet_model_best.pth.tar",
        f"{_CUNJIAN_RAW}/checkpoint/mobilefacenet_model_best.pth.tar",
        "b994af026bfddbafc507a6f1c8737a9896bab20ed2b0cfb6ae90b81736970313",
    ),
    "embedder.ckpt": (
        "xiaoccer_068.ckpt",
        f"{_XIAOCCER_RAW}/model/best/068.ckpt",
        "e839247cdbdfc023fb7cadeaf53a4549d50c8fc24ad154c02e35920ea8910d99",
    ),
    "test_1.jpg": (
        "test_1.jpg",
        f"{_SDK_RAW}/test/1.jpg",
        "d80e0f04965730ca8bdf444c48b4d3efd39875e7904df70144d60937296759df",
    ),
    "test_2.png": (
        "test_2.png",
        f"{_SDK_RAW}/test/2.png",
        "020ed5252b98fad3b99adf753fcf9eb1c55a24f26eb02ea54fc87e01be94b304",
    ),
    # -- third-party architecture definitions ---------------------------------
    "cunjian_mobilefacenet.py": (
        "cunjian_mobilefacenet.py",
        f"{_CUNJIAN_RAW}/models/mobilefacenet.py",
        "eb805643d9568cdae1334ec92660322af8affda1ed8ffb2bcbae4ab3368c907d",
    ),
    "xiaoccer_model.py": (
        "xiaoccer_model.py",
        f"{_XIAOCCER_RAW}/core/model.py",
        "22749d05ab72b987964d539e16ad806688f818e64bca87df0626f721742661b5",
    ),
    # -- upstream SDK reference sources (imported verbatim by gen_fixtures) ---
    "sdk/mb_tiny.py": (
        "sdk/face_detect/vision/nn/mb_tiny.py",
        f"{_SDK_RAW}/face_detect/vision/nn/mb_tiny.py",
        "f2b99930b63f732c15353296971416fde7612a992ca362d3a6b7dc1cbe6206ef",
    ),
    "sdk/ssd.py": (
        "sdk/face_detect/vision/ssd/ssd.py",
        f"{_SDK_RAW}/face_detect/vision/ssd/ssd.py",
        "15674aa58d2a1c0fdfd9edaba1bd21b47aa154d97f5649a152268646d45f654d",
    ),
    "sdk/mb_tiny_fd.py": (
        "sdk/face_detect/vision/ssd/mb_tiny_fd.py",
        f"{_SDK_RAW}/face_detect/vision/ssd/mb_tiny_fd.py",
        "cf34fbf146afd5cce39d1f7c25b46d1211caccbc7156c10014cc6ba415992714",
    ),
    "sdk/predictor.py": (
        "sdk/face_detect/vision/ssd/predictor.py",
        f"{_SDK_RAW}/face_detect/vision/ssd/predictor.py",
        "f29fd6c0bae6665232a46e89bfee1c4063cef66bf66486547a331712958a5861",
    ),
    "sdk/data_preprocessing.py": (
        "sdk/face_detect/vision/ssd/data_preprocessing.py",
        f"{_SDK_RAW}/face_detect/vision/ssd/data_preprocessing.py",
        "b04f1ee6c8bf1bdd74d351b9b4ed71a964fb9ae65204feb9653b27ccda3d606b",
    ),
    "sdk/transforms.py": (
        "sdk/face_detect/vision/transforms/transforms.py",
        f"{_SDK_RAW}/face_detect/vision/transforms/transforms.py",
        "5e6fb9d05088637ec5e8ecdcdc08216d8a15bb3041c3f56d9c2924eff2d8b65c",
    ),
    "sdk/fd_config.py": (
        "sdk/face_detect/vision/ssd/config/fd_config.py",
        f"{_SDK_RAW}/face_detect/vision/ssd/config/fd_config.py",
        "ffda3a36796224782a6885b7ee708b96ac011bdb82585137af9bf4f868791f11",
    ),
    "sdk/box_utils.py": (
        "sdk/face_detect/vision/utils/box_utils.py",
        f"{_SDK_RAW}/face_detect/vision/utils/box_utils.py",
        "ecd23687bc1b5cb29b322907f932c89e406853c453e3a4a2cedaf76bf0017397",
    ),
    "sdk/misc.py": (
        "sdk/face_detect/vision/utils/misc.py",
        f"{_SDK_RAW}/face_detect/vision/utils/misc.py",
        "14219be12493ce5cd9179403ad2d64cba39816dbf716db0cb8c0aebaae21951c",
    ),
    "sdk/MobileFaceNet.py": (
        "sdk/face_landmark/MobileFaceNet.py",
        f"{_SDK_RAW}/face_landmark/MobileFaceNet.py",
        "a502b5b14c13bd9ec1f21e33ed9ccc826451d9df1ce1423ef967dbdcd48ec623",
    ),
    "sdk/irn50_pytorch.py": (
        "sdk/face_feature/irn50_pytorch.py",
        f"{_SDK_RAW}/face_feature/irn50_pytorch.py",
        "bae024d2e0245b6879c70e50cafa6228a7b69992c59934dadcc94e4080a4c757",
    ),
}


def sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
            expected = r.headers.get("Content-Length")
        got = tmp.stat().st_size
        # urllib can return a truncated body without raising (observed through
        # the egress proxy); the SHA pin would still catch it, but retry here.
        if expected is not None and got != int(expected):
            raise IOError(f"truncated download: got {got} of {expected} bytes")
    except Exception as exc:  # fall back to curl (uses the same proxy/CA env)
        print(f"  urllib failed ({exc}); retrying with curl", file=sys.stderr)
        subprocess.run(["curl", "-sfSL", "--retry", "3", "-o", str(tmp), url], check=True)
    tmp.rename(dest)


def ensure(*names: str) -> dict[str, Path]:
    """Download (if absent) and SHA-256-verify the named artifacts.

    Returns name -> local path. Aborts with a clear message on pin mismatch.
    """
    out: dict[str, Path] = {}
    for name in names:
        rel, url, pin = FILES[name]
        dest = CACHE_DIR / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            print(f"fetching {url}")
            _download(url, dest)
        actual = sha256_path(dest)
        if actual != pin:
            dest.rename(dest.with_suffix(dest.suffix + ".bad"))
            sys.exit(
                f"ERROR: SHA-256 mismatch for {name} ({url})\n"
                f"  expected {pin}\n  actual   {actual}\n"
                f"  the offending file was moved to {dest}.bad; upstream content changed "
                f"or the download was corrupted — do not use it."
            )
        out[name] = dest
    return out


def ensure_all() -> dict[str, Path]:
    return ensure(*FILES.keys())


def load_py_module(path: Path, name: str):
    """Import a single .py file under a private module name."""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def install_import_stubs() -> None:
    """Make the upstream sources importable without cv2/torchvision.

    ``face_detect.vision.ssd.mb_tiny_fd`` transitively imports cv2 and
    torchvision at module level but gen_fixtures never calls into them, so
    empty stub modules suffice (only installed when the real ones are absent).
    """
    for name in ("cv2",):
        try:
            __import__(name)
        except ImportError:
            sys.modules[name] = types.ModuleType(name)
    try:
        __import__("torchvision")
    except ImportError:
        tv = types.ModuleType("torchvision")
        tvt = types.ModuleType("torchvision.transforms")
        tv.transforms = tvt
        sys.modules["torchvision"] = tv
        sys.modules["torchvision.transforms"] = tvt


def add_sdk_to_path() -> None:
    p = str(SDK_DIR)
    if p not in sys.path:
        sys.path.insert(0, p)


# ---------------------------------------------------------------------------
# Deterministic synthetic weights — recipe "randn-kaiming-v1" (see naming.md)
#
# The originally proposed recipe (every float tensor = randn*0.02) is
# degenerate on these depths: BatchNorm gains of ~0.02 attenuate the signal
# ~50x per layer, and the measured network output becomes *bit-identical* for
# different inputs (max|dOut| == 0.0 for the slim-320 detector). Such a
# fixture cannot catch input-path bugs. This recipe keeps unit-scale
# activations while remaining tiny and fully deterministic.
# ---------------------------------------------------------------------------

import torch  # noqa: E402  (kept below the pure-stdlib helpers on purpose)


def fill_random_state(module: "torch.nn.Module", seed: int) -> None:
    """Overwrite every parameter/buffer with seeded pseudo-random values.

    Iterates ``module.state_dict()`` in key order with a single
    ``torch.Generator`` seeded once, so the result depends only on ``seed``
    and the architecture. Per-tensor rule ("randn-kaiming-v1"):

    - non-floating tensors and keys ending ``num_batches_tracked``: untouched
    - keys ending ``running_var``:            ``|randn| * 0.02 + 1.0``
    - tensors with ``dim >= 2`` (conv/linear weights):
      ``randn * sqrt(2 / fan_in)`` with ``fan_in = numel / shape[0]``
    - remaining 1-D/0-D tensors ending ``.weight`` (BatchNorm gain, PReLU
      slope):                                  ``|randn| * 0.02 + 1.0``
    - everything else (biases, running_mean):  ``randn * 0.02``
    """
    g = torch.Generator().manual_seed(seed)
    sd = module.state_dict()
    for key in sd:
        t = sd[key]
        if not torch.is_floating_point(t) or key.endswith("num_batches_tracked"):
            continue
        if key.endswith("running_var"):
            t.copy_(torch.randn(t.shape, generator=g).abs() * 0.02 + 1.0)
        elif t.dim() >= 2:
            fan_in = t.numel() // t.shape[0]
            t.copy_(torch.randn(t.shape, generator=g) * math.sqrt(2.0 / fan_in))
        elif key.endswith(".weight"):
            t.copy_(torch.randn(t.shape, generator=g).abs() * 0.02 + 1.0)
        else:
            t.copy_(torch.randn(t.shape, generator=g) * 0.02)


def pseudo_image(seed: int, shape: tuple[int, ...], domain: str) -> "torch.Tensor":
    """Deterministic pseudo-random image tensor in a given preprocessed domain.

    Draws integer pixel values uniformly from [0, 256) with a
    ``torch.Generator`` seeded ``seed``, then applies the stage's exact
    normalization:

    - ``"det"``:    (x - 127) / 128      (detector, ADR-0004)
    - ``"unit"``:   x / 255              (cunjian landmark preprocessing)
    - ``"unit256"``: x / 256             (upstream embedder quirk, ADR-0004)
    - ``"pm1"``:    (x - 127.5) / 128    (Xiaoccer LFW eval preprocessing)
    """
    g = torch.Generator().manual_seed(seed)
    raw = torch.randint(0, 256, shape, generator=g).to(torch.float32)
    if domain == "det":
        return (raw - 127.0) / 128.0
    if domain == "unit":
        return raw / 255.0
    if domain == "unit256":
        return raw / 256.0
    if domain == "pm1":
        return (raw - 127.5) / 128.0
    raise ValueError(f"unknown domain {domain!r}")


def strip_module_prefix(sd: dict) -> dict:
    return { (k[7:] if k.startswith("module.") else k): v for k, v in sd.items() }


def save_state_dict_safetensors(sd: dict, path: Path) -> dict[str, dict]:
    """Save a torch state_dict as safetensors, keys verbatim.

    Returns an ordered {key: {"shape": [...], "dtype": str}} description.
    """
    from safetensors.torch import save_file

    tensors = {k: v.detach().clone().contiguous() for k, v in sd.items()}
    path.parent.mkdir(parents=True, exist_ok=True)
    save_file(tensors, str(path))
    return {
        k: {"shape": list(v.shape), "dtype": str(v.dtype).replace("torch.", "")}
        for k, v in tensors.items()
    }


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")
