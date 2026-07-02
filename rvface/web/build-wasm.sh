#!/usr/bin/env bash
# Builds the rvface-wasm module for the web UI:
#   cargo (wasm-release, cpu + webgpu backends) -> wasm-bindgen (--target web)
#   -> wasm-opt -O2 -> web/src/wasm/ (git-ignored), then syncs the converted
# weights + manifests from models/ into web/public/models/ (git-ignored).
#
# Prints raw + gzipped sizes before/after wasm-opt and enforces the ADR-0006
# 3.5 MiB gzipped budget through check-size.sh.
#
# Usage: ./build-wasm.sh
#   RVFACE_WASM_FEATURES=cpu ./build-wasm.sh   # cpu-only build (no wgpu)
#   RVFACE_WASM_SIMD=0 ./build-wasm.sh         # disable wasm SIMD128
set -euo pipefail

WEB="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$WEB")"
OUT="$WEB/src/wasm"
PROFILE=wasm-release
# One binary carries both backends (ADR-0005); `cpu` is a default feature.
FEATURES="${RVFACE_WASM_FEATURES:-webgpu}"
# SIMD128 is supported by all evergreen browsers and speeds conv-heavy CPU
# inference substantially; opt out with RVFACE_WASM_SIMD=0.
SIMD="${RVFACE_WASM_SIMD:-1}"

command -v wasm-bindgen >/dev/null || {
  echo "build-wasm: wasm-bindgen CLI not found (cargo install wasm-bindgen-cli)" >&2
  exit 1
}
command -v wasm-opt >/dev/null || {
  echo "build-wasm: wasm-opt not found (npm i -g binaryen or distro package)" >&2
  exit 1
}

RUSTFLAGS_EXTRA=""
WASM_OPT_SIMD=()
if [[ "$SIMD" == "1" ]]; then
  RUSTFLAGS_EXTRA="-C target-feature=+simd128"
  WASM_OPT_SIMD=(--enable-simd)
  echo "== SIMD128 enabled =="
fi

echo "== cargo build -p rvface-wasm --profile $PROFILE --features $FEATURES =="
RUSTFLAGS="${RUSTFLAGS:-} $RUSTFLAGS_EXTRA" cargo build \
  --manifest-path "$ROOT/Cargo.toml" -p rvface-wasm \
  --target wasm32-unknown-unknown --profile "$PROFILE" --features "$FEATURES"

WASM="$ROOT/target/wasm32-unknown-unknown/$PROFILE/rvface_wasm.wasm"

echo "== wasm-bindgen --target web =="
mkdir -p "$OUT"
wasm-bindgen --target web --out-dir "$OUT" "$WASM"

BG="$OUT/rvface_wasm_bg.wasm"
fsize() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }
gzsize() { gzip -9 -c "$1" | wc -c; }
pre_raw=$(fsize "$BG")
pre_gz=$(gzsize "$BG")

echo "== wasm-opt -O2 =="
wasm-opt -O2 \
  --enable-bulk-memory \
  --enable-nontrapping-float-to-int \
  "${WASM_OPT_SIMD[@]}" \
  "$BG" -o "$BG.opt"
mv "$BG.opt" "$BG"
post_raw=$(fsize "$BG")
post_gz=$(gzsize "$BG")

printf 'build-wasm: before wasm-opt  raw=%d B  gzip=%d B\n' "$pre_raw" "$pre_gz"
printf 'build-wasm: after  wasm-opt  raw=%d B  gzip=%d B\n' "$post_raw" "$post_gz"

# ADR-0006 budget gate (3.5 MiB gzipped) on the artifact the UI ships.
"$WEB/check-size.sh" "$BG"

echo "== syncing weights + manifests into web/public/models/ =="
mkdir -p "$WEB/public/models"
missing=0
for f in detector-slim320.safetensors landmark-mfn68.safetensors \
         embedder-mfn.safetensors landmark-mfn68.manifest.json \
         embedder-mfn.manifest.json; do
  if [[ -f "$ROOT/models/$f" ]]; then
    cp -f "$ROOT/models/$f" "$WEB/public/models/$f"
    echo "  synced $f"
  else
    echo "  MISSING models/$f — run: python3 tools/fetch_and_convert.py" >&2
    missing=1
  fi
done
if (( missing )); then
  echo "build-wasm: wasm built, but the UI cannot run without the weight files above" >&2
  exit 1
fi
echo "build-wasm: done — wasm in web/src/wasm/, weights in web/public/models/"
