#!/usr/bin/env bash
# ADR-0006 wasm size budget check: the shipped wasm binary must be
# <= 3.5 MiB gzipped.
#
# Usage:
#   ./check-size.sh                 # checks every .wasm in dist/ (after `npm run build`)
#   ./check-size.sh file.wasm ...   # checks the given artifacts (used by build-wasm.sh)
set -euo pipefail

BUDGET_BYTES=$((3670016)) # 3.5 MiB
DIST="$(cd "$(dirname "$0")" && pwd)/dist"

declare -a WASM_FILES
if (( $# > 0 )); then
  WASM_FILES=("$@")
else
  if [[ ! -d "$DIST" ]]; then
    echo "check-size: dist/ not found — run 'npm run build' first" >&2
    exit 1
  fi
  mapfile -t WASM_FILES < <(find "$DIST" -name '*.wasm' -type f)
  if [[ ${#WASM_FILES[@]} -eq 0 ]]; then
    echo "check-size: FAIL — no .wasm in dist/; the UI ships the real engine only (run ./build-wasm.sh before 'npm run build')" >&2
    exit 1
  fi
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
