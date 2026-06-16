# ADR-046: Real-Install Host Verification (and the schema bugs it caught)

**Status**: Implemented (2026-06-16)
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-036 (host-opencode), ADR-004 (host integration), ADR-044 (capability coverage), ADR-045 (CLI host wiring)

---

## Context

ADR-044 verified hosts two ways: (1) the emitted config parses + has the
expected keys, and (2) the generated *content* is coherent to a real model via
OpenRouter. Neither feeds the config to the **actual host runtime**. The
question "are all hosts proven functional using actual installs?" exposed that
gap: only claude-code had ever been run against its real CLI (`claude -p`).

This ADR records a pass where each *feasible* host was **installed and run**.
It caught three real schema bugs that both the schema-level and live-content
checks had missed — because neither had ever started the real host.

## What was verified, and how

| Host | Real runtime exercised | Result |
|------|---|---|
| **claude-code** | `claude -p` + `claude -p --plugin-dir` (real Anthropic CLI) | ✅ runs; returns sentinel |
| **codex** | `codex 0.140.0` — `codex doctor` (config parse + MCP register) + `codex exec` via OpenRouter | ✅ config valid; runs → `CODEX_REAL_OK`. No fix needed. |
| **opencode** | `opencode 1.17.7` — `opencode run` via OpenRouter | ❌→✅ **config REJECTED**; fixed; re-run loads config + runs → `OPENCODE_CLI_FIXED_OK` |
| **openclaw** | `openclaw 2026.6.8` — `openclaw config validate` / `config schema` | ❌→✅ **"Invalid input"**; fixed; re-validate → `Config valid` |
| **github-actions** | `act 0.2.89` — ran the generated workflow in Docker (real runner image) | ✅ job succeeded; composite action executed |
| **hermes** | schema diff vs authoritative `cli-config.yaml.example` | ❌→✅ **schema mismatch**; fixed against template (not live-run — see below) |

### Not locally feasible (documented, not faked)

- **pi-dev**: no cleanly-installable npm package for the badlogic Pi coding
  agent in this environment — `@mariozechner/pi` ships `pi-pods`, `@badlogic/pi`
  is "Prime Intellect CLI". Not the pi.dev coding agent. Left unverified.
- **rvm**: an AArch64 bare-metal microhypervisor built from source — cannot run
  on this x86 host at all.
- **copilot**: requires interactive VSCode 1.99+ with a Copilot subscription —
  no headless path.
- **hermes**: the installer needs `uv` + a repo clone + python/node deps + an
  **interactive** API-key/gateway setup stage. Config was corrected against the
  authoritative template; a full live run was not performed.

## The three bugs (only real installs caught these)

1. **opencode** (fixed): real opencode parses `mcp` as a direct name→server map,
   so our `mcp.servers` + `mcp.permissions` keys were read as two malformed
   servers. Correct shape: `mcp.<name> = {type:"local",command:[full array],
   enabled:true}` (or `{type:"remote",url,enabled}`); env key is `environment`;
   permissions live in a **top-level** `permission` object (`"ask"|"allow"|
   "deny"`, `bash` as a glob→decision map) — there is no `mcp.permissions`.

2. **openclaw** (fixed): real schema nests MCP under `mcp.servers.<name>` with a
   required `enabled` flag — NOT top-level `mcp_servers`. OpenClaw has no
   top-level allow/deny `permissions` concept (tool gating is the structured
   `approvals.exec`/`security.installPolicy`), so we emit only the valid
   `mcp.servers` block rather than invent rejected keys.

3. **hermes** (fixed vs template): real hermes config is a nested schema
   (`model:`, `agent:`, `skills:`, `memory:`, …) with **no** `name`/`description`/
   `system_prompt`/`scrub_*`/`agents:` top-level keys. The harness identity now
   maps to `model.provider: "auto"` + `agent.personalities.<name>` (a name→prompt
   map). Hermes-4 `<think>`/`<tool_call>` scrubbing is runtime logic, not a
   config key, so it is no longer written into the YAML.

Each fix was applied in all three codegen paths — the adapter
(`packages/host-*`), the CLI (`packages/create-agent-harness/src/host-config.ts`),
and the web-UI (`apps/web-ui/src/generator/scaffold.ts`) — and the host unit
tests updated to assert the verified-real schema.

## Decision

- Treat **real-install execution** as the top tier of host verification, above
  schema-shape and live-content checks. The OpenRouter live-content check
  (ADR-044) and schema checks remain useful fast gates, but they are NOT
  sufficient on their own — they passed on configs three real hosts rejected.
- `scripts/verify-all-hosts.mjs` already scaffolds via the real `--host` path
  (ADR-045); where a host runtime is installed it should additionally be run
  (claude-code already does). Wiring `opencode run` / `codex exec` /
  `openclaw config validate` / `act` into an opt-in `--real` mode of that gate
  is a follow-up.

## Consequences

- The opencode/openclaw/hermes adapters now emit configs the real runtimes
  accept (opencode + openclaw verified live; hermes verified vs the template).
- ADR-036's "pin a schema snapshot" assumption was the root cause for opencode —
  the pinned shape was never validated against a real install and had drifted.
- pi-dev/rvm/copilot remain schema-/content-verified only, with the specific
  reason each can't be run here recorded above (no silent "verified").
