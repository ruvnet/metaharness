# ADR-045: CLI Scaffold Does Not Invoke Host Adapters for Non-Claude Hosts

**Status**: Implemented (2026-06-16)
**Date**: 2026-06-16
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-004 (host integration model), ADR-027 (CLI ↔ web-UI parity), ADR-044 (host capability coverage)

---

## Context

The ADR-044 review verified live that a CLI-scaffolded harness works against a
real model (`scripts/verify-harness-live.mjs --dir demo-bot` → PASS, OpenRouter,
$0.000286). While scaffolding the verification fixture, a distinct gap surfaced.

`npx metaharness <name> --host opencode` (or any non-`claude-code` host):
- records `manifest.hosts = ['opencode']`, but
- emits **only `.claude/*` config** (`.claude/settings.json`, `CLAUDE.md`,
  `.claude/commands/`, `.claude-plugin/plugin.json`).

No `.opencode/opencode.json` is written. The CLI scaffolder
(`packages/create-agent-harness/src/index.ts` → `walkTemplate`) renders from
the claude-shaped `templates/<vertical>/` directories and **never invokes the
`@metaharness/host-*` adapter packages**. So the host adapters — now fully
spec-complete and tested (ADR-044, 153 unit tests) — are not actually reached by
the primary `npx metaharness` scaffold path for 8 of 9 hosts.

This means there are **three** host-config codegen paths today, only one of
which is exercised end-to-end by `npx metaharness`:

| Path | Used by | Covers all 9 hosts? |
|------|---------|:---:|
| `packages/host-*/src/index.ts` (adapters) | unit tests, `scripts/verify-all-hosts.mjs` (`bot-<host>/`) | ✅ (ADR-044) |
| `apps/web-ui/src/generator/scaffold.ts` | the Studio (web UI) | ✅ (ADR-044 iter 7) |
| `packages/create-agent-harness/templates/` | `npx metaharness <name> --host X` | ❌ claude-shaped only |

`verify-all-hosts.mjs` passes because its `bot-<host>/` fixtures are produced by
calling the adapters directly (or fall back to a dep-presence check), not by the
`npx metaharness --host` path — so this gap was invisible to the existing gate.

## Decision (implemented)

Emit the selected host's native config from the CLI scaffold path:

1. Added `packages/create-agent-harness/src/host-config.ts` — a
   **dependency-free** `hostConfigFiles(host, { name, description, mcp, … })`
   that returns the host's config files. It does NOT import the
   `@metaharness/host-*` packages (keeps the published `metaharness` CLI
   standalone) and mirrors `apps/web-ui/src/generator/scaffold.ts` so the CLI
   and web-UI surfaces stay byte-parity-aligned (ADR-027). `claude-code` returns
   `[]` — the templates already own the richer `.claude/` tree.
2. `scaffold()` (`src/index.ts`) merges those files into the rendered tree
   **before** computing manifest fingerprints (so they are tracked + witnessed),
   never clobbering a template file.
3. `scripts/verify-all-hosts.mjs` now scaffolds each host through the real
   `node dist/bin.js <name> --host <X>` path into a temp dir, then runs the
   schema checks — so the gate can never again pass while `--host X` emits the
   wrong tree. (Also fixed a latent EISDIR in the github-actions check that this
   real-scaffold step exposed.)

**Verified**: `--host opencode/codex/copilot/github-actions/hermes/openclaw/
pi-dev/rvm/claude-code` each emit their native config; the hardened gate reports
9/9; and `scripts/verify-harness-live.mjs --all` live-verifies all 9 against a
real model via OpenRouter (9/9 PASS, ~$0.0027 total). +10 CLI unit tests.

### Why dependency-free instead of importing the adapters

The canonical adapters live in `@metaharness/host-*`. Importing them would add 9
deps to the standalone `metaharness` CLI and couple publish ordering. The
adapters and `host-config.ts` are kept in lockstep by the parity tests; if they
diverge, a future refactor can extract one shared module once the CLI and web-UI
share a build boundary.

## Consequences

- **Positive**: closes the loop so the spec-complete adapters actually ship
  through the CLI; the three codegen paths converge; the gate stops being
  fooled by adapter-direct fixtures.
- **Risk if not done**: a user running `npx metaharness mybot --host opencode`
  gets a claude-shaped harness, not an OpenCode one — the headline multi-host
  promise is only half-delivered on the CLI.
- **Interim**: the web-UI (Studio) path and the adapters themselves are correct
  and live-verified; only the `npx metaharness --host` wiring lags.
