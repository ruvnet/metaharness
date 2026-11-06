# 0.4.20 — 2026-11-05

Security: depend on `@metaharness/darwin` `^0.13.0` (the previous `^0.10.0` range only resolved 0.10.x, so fixes in later darwin releases never reached installs), and scaffold new harnesses with `@metaharness/darwin` `^0.13.0` instead of `^0.8.0`. `--with-wasm` now invokes `wasm-pack` with an argument array instead of a shell string. See GHSA-mjwg-5fm3-fx2p.

# 0.4.19 — 2026-10-21

Correct repository metadata for npm provenance. Includes the Dream integration prepared in 0.4.18, whose publication was rejected before any package was published.

Also: generated harnesses now ship an executable MCP runtime (`assets/generated-mcp.mjs`) covered by installed-package journey tests; `upgrade` rejects symbolic-link and unsafe paths, never truncates an existing `.rej` proposal, creates files exclusively, and writes structured config (JSON/TOML/YAML) conflicts as `.rej` files so active policy stays parseable.

# 0.4.18 — 2026-10-21

Integrate Dream CLI and MCP policy fixes, preserve overlays on upgrade, and recognize OpenClaw doctor artifacts.

# Changelog
