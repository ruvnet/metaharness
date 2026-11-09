#!/usr/bin/env bash
# Install the pinned wasm toolchain from crates.io with `cargo install --locked`.
#
# Nothing here downloads from GitHub release assets. wasm-pack's curl installer,
# its on-demand wasm-bindgen download and its on-demand binaryen (wasm-opt)
# download all fetch GitHub releases; those returned 504s and turned main CI red
# on 7136c872. wasm-pack uses a wasm-opt found on PATH, and a wasm-bindgen on PATH
# whose version equals the one in Cargo.lock, so pre-installing both here removes
# every network fetch from `wasm-pack build` except crates.io.
#
# Each install is skipped when the right version is already on PATH (the cargo
# bin directory is cached by Swatinem/rust-cache), and retried on failure.
set -euo pipefail

WASM_PACK_VERSION=0.13.1
# Must equal the exact `wasm-bindgen = "=X"` pin in the root Cargo.toml.
WASM_BINDGEN_VERSION=0.2.130
# The wasm-opt crate builds binaryen from source; 0.116.1 is binaryen version_116.
WASM_OPT_VERSION=0.116.1
WASM_OPT_BINARYEN=version_116

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pinned="$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)".*/\1/p' "$root/Cargo.toml")"
if [ "$pinned" != "$WASM_BINDGEN_VERSION" ]; then
  echo "::error::Cargo.toml pins wasm-bindgen '$pinned' but install-wasm-tools.sh installs $WASM_BINDGEN_VERSION" >&2
  exit 1
fi

install() { # <binary> <crate> <version> <substring of `binary --version` output>
  if command -v "$1" >/dev/null 2>&1 && "$1" --version 2>/dev/null | grep -qF "$4"; then
    echo "$1: $("$1" --version) already installed"
    return 0
  fi
  for attempt in 1 2 3; do
    if cargo install "$2" --version "$3" --locked --force; then return 0; fi
    echo "cargo install $2@$3 failed (attempt $attempt); retrying" >&2
    sleep $((attempt * 15))
  done
  echo "::error::could not install $2@$3" >&2
  return 1
}

install wasm-pack wasm-pack "$WASM_PACK_VERSION" "wasm-pack $WASM_PACK_VERSION"
install wasm-bindgen wasm-bindgen-cli "$WASM_BINDGEN_VERSION" "wasm-bindgen $WASM_BINDGEN_VERSION"
install wasm-opt wasm-opt "$WASM_OPT_VERSION" "($WASM_OPT_BINARYEN)"
wasm-pack --version
wasm-bindgen --version
wasm-opt --version
