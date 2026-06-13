# Contributing to agent-harness-generator

Thanks for considering contributing. This repo is currently in the **design + scaffold** phase — most of the implementation work is happening on a `/loop` cadence against the ADR set in [`docs/adrs/`](./docs/adrs/INDEX.md). Engineers familiar with the design are welcome to push back on any decision.

## Quick start

```bash
git clone https://github.com/ruvnet/agent-harness-generator
cd agent-harness-generator

# Rust workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check

# WASM build (needs wasm-pack)
npm run build:wasm

# Native build (needs @napi-rs/cli)
npm run build:napi

# TypeScript + smoke test
npm install
npm run build
npm test
npm run smoke
```

## Repo layout

| Path | Purpose |
|---|---|
| `crates/kernel/` | The Rust kernel — seven subsystems per [ADR-002](./docs/adrs/ADR-002-kernel-boundary.md) |
| `crates/kernel-wasm/` | wasm-bindgen surface — primary distribution target |
| `crates/kernel-napi/` | NAPI-RS surface — native Node.js fallback per [ADR-002a](./docs/adrs/ADR-002a-rust-wasm-napi-publishing-pipeline.md) |
| `packages/kernel-js/` | `@ruflo/kernel` runtime resolver |
| `packages/create-agent-harness/` | `create-agent-harness` CLI entry point |
| `.github/workflows/` | CI, publish (GCP-secret-gated), security |
| `docs/adrs/` | 17 ADRs defining the system end-to-end |

## Design first

Every load-bearing change requires either updating an existing ADR or adding a new one.

## Tests are not optional

- Every kernel module ships with `#[cfg(test)]` tests in the same file
- TypeScript packages use vitest
- The `scripts/smoke.mjs` pre-publish gate is part of the CI publish job

## Publish pipeline

`npm publish` only runs in CI from a tagged release, gated on a successful GCP Workload Identity Federation auth + Secret Manager fetch of `NPM_TOKEN`. See [`.github/workflows/publish.yml`](./.github/workflows/publish.yml).

## License

MIT — see [LICENSE](./LICENSE).
