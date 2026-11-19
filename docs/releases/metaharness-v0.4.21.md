# metaharness 0.4.21 — ecosystem ranges and audit fixes

Package: `metaharness@0.4.21` only. Its dependency `@metaharness/darwin` stays at `^0.13.0`.

- `@ruvector/ruvllm` (optional, used by `analyze-repo --embed`): `^2.5.6` → `^4.1.0`. Version 4.1.0 is the current runtime. Versions 4.0.0 and 4.0.1 were published from the wrong repository, and the new range excludes them. The `RuvLLM` / `embed()` API used by the embedding path is unchanged between 2.5.7, 2.7.0 and 4.1.0. 4.1.0 also brings in `@ruvector/ruvllm-gpu-loop@^1.0.0` as an optional dependency.
- Root workspace overrides `glob@^14.0.2` and `minimatch@^11.0.1` clear GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249, which came in through `@metaharness/agntcy` → `agntcy-dir` → `sigstore` / `tuf-js` (#466). The installed-artifact smoke test still runs AGNTCY, sigstore and the CLI.
- Release workflow: a `<package>-vX.Y.Z` tag now publishes only that package, with npm provenance. `dream-vX.Y.Z` keeps the four-package Dream set. `v*` tags no longer publish every workspace package.

| Range | Before | After | Note |
| --- | --- | --- | --- |
| `metaharness` → `@ruvector/ruvllm` | `^2.5.6` (resolved 2.7.0) | `^4.1.0` | — |
| `metaharness` → `@metaharness/darwin` | `^0.13.0` | `^0.13.0` | already latest |
| `@metaharness/kernel` → `@ruvector/emergent-time` | `^0.1.0` | unchanged | latest 0.1.2 is in range |
| `@metaharness/kernel` → `@ruvector/rvf` (peer, optional) | `^0.2.0` | unchanged | #555 hardening shipped in 0.2.3, which is in range. No advisories. Widening needs a kernel release. |
| `@metaharness/router` → `@ruvector/tiny-dancer` (peer) | `^0.1.21` | unchanged | latest 0.1.24 is in range |
| `@ruvector/attention` | not a dependency | — | — |

Reproduce: `npm ci --ignore-scripts`, `npm run build`, `npm audit --audit-level=moderate`, `RELEASE_PACKAGES=create-agent-harness node scripts/dream-release.mjs pack`, `RELEASE_PACKAGES=create-agent-harness node scripts/dream-release.mjs smoke`.
