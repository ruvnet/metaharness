# Contributing to agent-harness-generator

Thanks for considering contributing. The pipeline is production-ready (50+ iters, 478+ tests, 16-job CI matrix). Most contributions land via `/loop` against the [ADR set](./docs/adrs/INDEX.md); design pushback is welcome.

## Orientation map

```bash
node scripts/dev-toolkit.mjs            # everything the repo offers, one screen
node scripts/dev-toolkit.mjs --filter=release   # narrow to one topic
node scripts/dev-toolkit.mjs --check-health     # verify the toolkit isn't broken
node scripts/dev-toolkit.mjs --json              # machine-readable
```

Single command tells you every dev script + every `harness` subcommand + every CI job + every entry point.

## Day-to-day commands

| Question | Command | Wall time |
|---|---|---|
| Did I break anything? | `node scripts/healthcheck.mjs` | <1s |
| Is this scaffolded harness OK? | `harness validate <path>` | <1s |
| Is this branch release-ready? | `node scripts/preflight.mjs` | ~30s |
| Cut a release | `node scripts/release.mjs <bump> --push` | ~60s |

## First-time setup

```bash
git clone https://github.com/ruvnet/metaharness
cd metaharness

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

# Confirm the toolkit is wired
node scripts/dev-toolkit.mjs --check-health
```

## Repo layout

| Path | Purpose |
|---|---|
| `crates/kernel/` | The Rust kernel — seven subsystems per [ADR-002](./docs/adrs/ADR-002-kernel-boundary.md) |
| `crates/kernel-wasm/` | wasm-bindgen surface — primary distribution target |
| `crates/kernel-napi/` | NAPI-RS surface — native Node.js fallback per [ADR-002a](./docs/adrs/ADR-002a-rust-wasm-napi-publishing-pipeline.md) |
| `packages/kernel-js/` | `@metaharness/kernel` runtime resolver |
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
