# ADR-045: CLI Scaffold Does Not Invoke Host Adapters for Non-Claude Hosts

**Status**: Proposed (follow-up — discovered during the ADR-044 review)
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

## Decision (proposed)

Wire the host adapters into the CLI scaffold so `--host X` emits X's config:

1. After `walkTemplate` renders the claude-shaped base tree, build a
   `HarnessSpec` from the resolved template + manifest (name, description,
   systemPrompt, agents, mcpServers, permissions).
2. For each `opts.host`, call `@metaharness/host-<host>`'s
   `adapter.generateConfig(spec)` and merge the returned file map into the
   scaffold (host-specific files win; claude-base stays for `claude-code`).
3. Make `verify-all-hosts.mjs` scaffold its `bot-<host>/` fixtures via the real
   `npx metaharness --host` path so this can never silently regress again.

This is deferred to a follow-on PR because it is a cross-cutting wiring change
(spec construction + multi-host merge + the gate change), larger than the
single-host capability fixes of ADR-044. ADR-044's objective — every adapter
fully consumes the spec — is complete; this ADR tracks getting that output in
front of `npx metaharness` users.

## Consequences

- **Positive**: closes the loop so the spec-complete adapters actually ship
  through the CLI; the three codegen paths converge; the gate stops being
  fooled by adapter-direct fixtures.
- **Risk if not done**: a user running `npx metaharness mybot --host opencode`
  gets a claude-shaped harness, not an OpenCode one — the headline multi-host
  promise is only half-delivered on the CLI.
- **Interim**: the web-UI (Studio) path and the adapters themselves are correct
  and live-verified; only the `npx metaharness --host` wiring lags.
