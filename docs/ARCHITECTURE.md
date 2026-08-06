# Architecture

A bird's-eye view of how `agent-harness-generator` is wired. The detail lives in `docs/adrs/`; this is the layered map.

## The three-layer model

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 3 — User-facing surface                                    │
│                                                                  │
│   create-agent-harness (CLI)   examples/quickstart               │
│   harness CLI subcommands       examples/federation              │
│   .claude-plugin/plugin.json    .codex/skills/*                  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ Layer 2 — Adapter + Application layer                            │
│                                                                  │
│   @metaharness/host-claude-code   @metaharness/host-codex        │
│   @metaharness/host-pi-dev        @metaharness/host-hermes       │
│   @metaharness/host-openclaw      @metaharness/host-rvm          │
│   @metaharness/host-copilot       @metaharness/host-opencode     │
│   @metaharness/host-github-actions  @metaharness/host-prime-agent│
│                                                                  │
│   @metaharness/sdk                @metaharness/vertical-base     │
│                                   @metaharness/vertical-trading  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ Layer 1 — Kernel                                                 │
│                                                                  │
│   crates/kernel       (Rust core: claims, hooks, intel, mcp,     │
│                        memory, routing, witness, federation)     │
│   crates/kernel-wasm  (wasm-bindgen target)                      │
│   crates/kernel-napi  (NAPI-RS target)                           │
│   @metaharness/kernel       (TS loader + bridge)                       │
└──────────────────────────────────────────────────────────────────┘
```

**Constraint**: nothing in Layer 1 imports from Layers 2 or 3. The kernel is portable. ADR-002 owns this boundary.

## Release pipeline

The release flow composes 6 primitives + 1 orchestrator (per ADR-019):

```
   scripts/release.mjs (iter 33)
        │
        ├──▶ 1. scripts/version-bump.mjs           (iter 29)
        │       atomic semver bump across 15 sources
        │
        ├──▶ 2. scripts/preflight.mjs              (iter 14)
        │       every gate publish.yml would run, locally
        │
        ├──▶ 3. scripts/marketplace-entry.mjs      (iter 27)
        │       regenerate IPFS-pinnable plugin JSON
        │
        ├──▶ 4. scripts/publish-dryrun.mjs         (iter 20)
        │       npm publish --dry-run × every package
        │
        ├──▶ 5. git commit + tag                   (iter 33)
        │       only after all gates pass
        │
        └──▶ 6. scripts/release-notes.mjs          (iter 36)
                CHANGELOG → dist/release-notes-v{X}.md
                for `gh release create`

           server-side: .github/workflows/publish.yml runs the same
           gates + GCP-WIF + actual npm publish + Pinata IPFS pin
```

`release.mjs` refuses to run with a dirty working tree, no git mutation until all gates pass, `--dry-run` for safe inspection.

## Validation surface

Three commands at different cadence levels:

| Command | When | Wall time | What it does |
|---|---|---|---|
| `harness validate <path> --skip-gcp` | Per-scaffolded-harness | <1s | doctor + witness verify + path-guard + mcp + (optional) GCP secret check |
| `node scripts/healthcheck.mjs` | Per-commit / per-PR | <1s | 6 read-only structural checks across the meta-repo |
| `node scripts/preflight.mjs` | Pre-release | ~30s | Every publish.yml gate, including `cargo test`, `wasm-pack build`, full vitest |
| `node scripts/release.mjs <bump>` | Release | ~60s | Composes all primitives + tags |

## CI matrix

`.github/workflows/ci.yml` runs a 16-job matrix on every push:

| Job | OS × N | What |
|---|---|---|
| Rust | 3 OS | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo doc -D warnings` |
| WASM | 3 OS | `wasm-pack build` + `wasm-tools validate` + 500 KB size budget |
| Node | 3 OS × 2 Node | `npm run build` + `npm test` + path-guard + healthcheck |
| pack+install | 3 OS | Batch-install every tarball (catches missing files, broken bins) |
| Bench (smoke) | 1 | Memory retrieval bench (`packages/bench`) |
| CI passed | 1 | Final aggregator for branch protection |

Plus `.github/workflows/security.yml` runs cargo-audit, cargo-deny, npm-audit, codeql, and `audit-deps-aggregate` (iter 38).

## Test contract enforcement

| Concern | Test file | Iter |
|---|---|---|
| End-to-end scaffold → validate | `__tests__/e2e-scaffold-validate.test.ts` | 23, 30 |
| MCP dispatch protocol | `__tests__/mcp-dispatch-integration.test.ts` | 34 |
| Witness shape gate | `__tests__/witness-tamper.test.ts` | 37 |
| Federation handshake | `examples/federation/` + tests | 9, 40 |
| Plugin schema | `__tests__/claude-marketplace-plugin.test.ts` | 24 |
| Codex skills schema | `__tests__/codex-skills.test.ts` | 22 |
| Marketplace entry shape | `__tests__/marketplace-entry.test.ts` | 27 |
| Workflows structural | `__tests__/workflows.test.ts` | 30 |
| Pack content invariants | `__tests__/pack-contents.test.ts` | 25 |
| Cross-platform paths | `__tests__/path-handling.test.ts` | 16 |
| Version bump atomicity | `__tests__/version-bump.test.ts` | 29 |
| Release orchestration | `__tests__/release.test.ts` | 33 |
| Release notes extraction | `__tests__/release-notes.test.ts` | 36 |
| ADR doc hygiene | `__tests__/adr-index.test.ts` | 35 |
| Examples runnability | `__tests__/examples-*.test.ts` | 32, 40 |
| Healthcheck contract | `__tests__/healthcheck.test.ts` | 42 |
| Audit aggregate | `__tests__/audit-deps.test.ts` | 38 |

## Key references

- **ADRs**: `docs/adrs/INDEX.md` — start there, then read the linked ADRs in order.
- **Release runbook**: `docs/RELEASE.md` — the user-facing flow.
- **Quickstart**: `examples/quickstart/quickstart.mjs` — fastest path to "is this working on my machine?".
- **CHANGELOG**: chronological list of every iter's changes.
