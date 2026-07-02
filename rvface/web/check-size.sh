#!/usr/bin/env bash
# ADR-0006 wasm size budget check: the shipped wasm binary must be
# <= 3.5 MB gzipped. Placeholder until rvface-wasm is built — passes
# with a notice when no wasm is present in dist/.
#
# Usage: ./check-size.sh   (after `npm run build`)
set -euo pipefail

BUDGET_BYTES=$((3670016)) # 3.5 MiB
DIST="$(cd "$(dirname "$0")" && pwd)/dist"

if [[ ! -d "$DIST" ]]; then
  echo "check-size: dist/ not found — run 'npm run build' first" >&2
  exit 1
fi

mapfile -t WASM_FILES < <(find "$DIST" -name '*.wasm' -type f)

if [[ ${#WASM_FILES[@]} -eq 0 ]]; then
  echo "check-size: no .wasm in dist/ (wasm module not built yet) — nothing to enforce"
  exit 0
fi

fail=0
for f in "${WASM_FILES[@]}"; do
  gz=$(gzip -9 -c "$f" | wc -c)
  raw=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
  printf 'check-size: %s  raw=%d B  gzip=%d B  budget=%d B\n' \
    "${f#"$DIST"/}" "$raw" "$gz" "$BUDGET_BYTES"
  if (( gz > BUDGET_BYTES )); then
    echo "check-size: FAIL — ${f#"$DIST"/} exceeds the ADR-0006 3.5 MB gzipped budget" >&2
    fail=1
  fi
done

if (( fail )); then
  exit 1
fi
echo "check-size: OK — within ADR-0006 budget"
