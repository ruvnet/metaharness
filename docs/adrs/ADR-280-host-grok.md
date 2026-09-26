# ADR-280: host-grok — xAI Grok Build CLI as the 11th implemented harness host

**Status**: Proposed — implementation included in the accompanying PR (flip to Implemented on merge)
**Date**: 2026-09-19
**Project**: `ruvnet/metaharness`
**Deciders**: ruv
**Tags**: grok, xai, host-adapter, mcp, toml, folder-trust, fail-closed
**Extends**: ADR-004 (Host integration model)
**Related**: ADR-022 (default-deny posture), ADR-027 (CLI ↔ web-UI parity), ADR-036 (per-host ADR precedent), ADR-044 (capability coverage), ADR-045 (CLI host wiring), ADR-046 (real-install verification), ADR-246 §2.2 (autonomous block), ADR-247 (fail-closed precedent)
**Prompted by**: GH #279 (host-grok proposal, verified against grok 1.0.17); complements GH #160 (Grok as a pipeline-stage model — a router concern, disjoint files)

---

## Context

Grok Build (`grok`, xAI's terminal coding agent, installed with
`curl -fsSL https://x.ai/cli/install.sh | bash`) is a Claude-Code-class CLI:
interactive TUI, headless `-p`, ACP agent mode, MCP client, skills, subagents,
lifecycle hooks, allow/ask/deny permission rules and an OS sandbox. People who
run Claude Code, Codex and Grok side by side already point all three at the
same MCP servers (ruflo's among them), but `npx metaharness <name> --host grok`
does not exist: `--host grok` exits 2 with `Unknown host: grok`.

Grok's project-scoped surface, verified on **grok 1.0.34 (3736acbc8658), macOS
arm64, 2026-09-19** with `grok inspect --json` and `grok mcp list` under a
throwaway `HOME`/`GROK_HOME` (the real `~/.grok` untouched), plus the user
guide the binary ships (cited as `NN-file.md §section`):

| Surface | Grok behaviour | Evidence |
|---|---|---|
| `.grok/config.toml` `[mcp_servers.<name>]` | Project MCP servers. `grok mcp add --scope project` writes `command`, `args`, `enabled = true`, `env`/`headers` as sub-tables, no `type` key for HTTP, `type = "sse"` for SSE. | VERIFIED (Grok wrote the file in a scratch project) |
| `type = "http"` in a server table | Accepted silently; transport `http`. | VERIFIED (#279 open question 1) |
| Project config tables | Only `[mcp_servers]`, `[plugins]`, `[permission]`, `[mcp] max_output_bytes` are read from a project file. | DOC (26-config-reference.md §How to configure) |
| `.grok/config.toml` `[permission]` `allow`/`deny` | Claude Code rule strings. The exact set the CLI scaffold emits (`mcp__<name>__*`, `Read(./.env)`, `Read(./.env.*)`, `Bash(rm:*)`, `Bash(git push:*)`, `Write(*)`, `Edit(*)`) loads **7/7, 0 skipped**; `MCPTool(x__*)` and `mcp__x` load too. | VERIFIED |
| Rules naming a tool outside Grok's vocabulary | `Task(*)`, `Agent(explore)`, `MultiEdit(*)`, `NotebookEdit(*)`, `LS(*)`, lowercase `bash(ls)` load **0** rules and are **not** listed in `permissions.skipped`. | VERIFIED (new; the guide says "skipped with a warning") |
| Folder trust | Untrusted: `projectTrusted: false`, `projectInstructions: []`, `skills: []`, `hooks: []`, `permissions.loaded: 0`. Project MCP servers and `.grok/agents` are still *listed*. | VERIFIED |
| Granting trust | `grok --trust inspect` writes `[folders."<path>"] trusted = true` to `$GROK_HOME/trusted_folders.toml` and prints what loaded; `GROK_FOLDER_TRUST=0` lifts the gate for one process. | VERIFIED (#279 open question 5, for the `inspect` path) |
| `--deny` flags | Always enforced, trusted or not. | DOC (22-permissions-and-safety.md §CLI Flags) |
| `AGENTS.md`, `CLAUDE.md` | Both load once trusted (`inspect` prints `Agents.md`/`Claude.md` on case-insensitive APFS). | VERIFIED |
| `.grok/skills/<n>/SKILL.md`, `.claude/skills/*/SKILL.md` | Both load once trusted (`.claude` via `[compat.claude]`, `vendor: claude`). | VERIFIED |
| `.grok/agents/<n>.md` | Listed as `source.type: project`; a file without `name` frontmatter is dropped silently. | VERIFIED |
| `.grok/hooks/*.json` | Claude three-level JSON, `command` and `http` handlers; loads once trusted; an unknown event (`Setup`) is dropped silently; a `"*"` matcher is listed verbatim. | VERIFIED (load); execution not attempted (needs a model session) |
| `.claude/settings.json` | Its `permissions` load once trusted; its `mcpServers` are **not** read. | VERIFIED (#279 had this DOC-ONLY) |
| `.mcp.json` | Discovered under a fresh home (`source.type: mcpJson`); skipped once the user has imported or dismissed the Claude import prompt. | VERIFIED (fresh home) + DOC (07-mcp-servers.md §Compatibility) |
| MCP server names | Config accepts any TOML key, but the tool catalog admits only names that start with a letter or `_`, use `[A-Za-z0-9_-]`, contain no `__` and do not end in `_`; tools are named `server__tool`. | VERIFIED (config accepts) + DOC (07-mcp-servers.md §What Grok admits) |
| Status line | User config only (`[ui.status_line]`). | DOC (05-configuration.md) |

What a claude-code scaffold already gets under Grok through `[compat.claude]`:
`CLAUDE.md`, `.claude/skills`, `.claude/commands`, and `.claude/settings.json`
permissions and hooks, all trust-gated. What it does not get is the harness
MCP server: Grok never reads `mcpServers` from `.claude/settings.json`, and
`install-mcp.sh` runs `claude mcp add`. That is the gap this host closes.

One property dominates the design, as sandboxing did for Prime Agent
(ADR-247): **a fresh scaffold is an untrusted folder, and Grok ignores every
project surface we emit, including the deny-list, until someone trusts it.**
Silently shipping a deny-list that is inert is the ADR-046 bug class.

## Decision

Ship `@metaharness/host-grok` (`packages/host-grok/`), the **11th implemented
adapter**, implementing `HostAdapter` (`packages/kernel-js/src/types.ts`), and
register `grok` in the CLI and web UI host catalogs.

### 2.1 Emission map

| HarnessSpec | Emitted | Rule |
|---|---|---|
| `mcpServers[]` | `.grok/config.toml` `[mcp_servers.<name>]` | stdio: `command` = argv[0], `args` = rest, `enabled = true`, `env` sub-table (duplicate keys: last wins). Remote: `url` + `enabled = true`, **no `type` key**. A server with neither is not emitted (Grok would drop it) and is named in the runbook. |
| `permissions.allow/deny` | `.grok/config.toml` `[permission]` | Verbatim, one rule per line. No table when both are empty. Rules outside Grok's vocabulary are named in the runbook. |
| `systemPrompt`, `description`, `agents` roster | `AGENTS.md` | host-codex ADR-044 shape, plus the `<server>__*` tool names. Emitted when any of these or a server is present. |
| `agents[]` | `.grok/agents/<name>.md` | `name` (normalized `[a-z0-9-]`, collision suffixes) + quoted `description`; body = system prompt. |
| `tools[]` | `.grok/skills/<name>/SKILL.md` | Instruction-only (ADR-247 doctrine: `ToolSpec` has no execution binding). |
| `hooks[]` | `.grok/hooks/<harness>.json` | §2.4. |
| `statusLine` | runbook "Unsupported on this host" | with the `[ui.status_line]` pointer. |
| `autonomous` (ADR-246 §2.2) | runbook "Autonomous mode" | `maxTurns` → `--max-turns`; `goal` → `/goal <text> [--budget N]`; `heartbeat` → `/loop <cadence> <instruction>`; `gateCommand` → documented no-op (§2.6). |
| always | `install-grok.md` | Host-qualified name (ADR-247 precedent). |

All renderers are pure and byte-deterministic. Every spec-derived string in
TOML goes through a full TOML 1.0 basic-string escaper (control characters,
DEL, lone surrogates), not the five-character host-codex escaper.

### 2.2 Fail-closed trust posture (the load-bearing rule)

1. When the output contains any trust-gated surface (`AGENTS.md`, a server, a
   permission rule, a skill, a hook), `install-grok.md` **opens** with an
   ACTION REQUIRED banner that lists what is inert until trust and names every
   `deny` rule as not enforced.
2. The runbook's headless command repeats every `deny` rule as a shell-quoted
   `--deny` flag, which Grok enforces regardless of trust.
3. The trust step is `grok --trust inspect`: it records trust and prints the
   loaded surfaces without starting a model session, so the user sees the
   emitted config take effect in one command.

### 2.3 Three codegen paths (ADR-027/045)

`packages/create-agent-harness/src/host-config.ts` gains `case 'grok'`
(`.grok/config.toml`, `AGENTS.md`, `install-grok.md`), and
`apps/web-ui/src/generator/scaffold.ts` the same case with the same helper
code. Parity is **tested**, not asserted: the web-UI suite imports the
dependency-free `host-config.ts` and compares every file byte for byte across
3 MCP modes × 2 × 2 policy flags; the adapter suite compares `configToml()`
with the CLI's `.grok/config.toml` for the local and off modes. (Remote
differs by design: `McpServerSpec` has no `headers` field, while the CLI entry
carries `Authorization: Bearer ${HARNESS_MCP_TOKEN}`, which Grok expands at
load time.)

### 2.4 Hooks

- Events: Grok's 15 documented events pass through (`SubagentEnd` is written
  as its canonical `SubagentStop`); anything else (`Setup`, `FileChanged`,
  `PermissionRequest`) is named in the runbook.
- Handlers: `http(s)://…` → `{type: "http", url}`. A plain helper name →
  `node "$GROK_WORKSPACE_ROOT/.claude/helpers/<name>.cjs"`, the same
  user-supplied file host-claude-code references, anchored at the workspace
  root because a relative hook `command` resolves against the JSON file's
  directory (`.grok/hooks/`), not the repo root. `mcp:`/`prompt:`/`agent:` handlers (no Grok type) and
  helper names outside `[A-Za-z0-9._-]` (not spliced into a shell line) are
  named in the runbook.
- Matchers: Grok compiles `matcher` as a regex over the tool name; empty or
  omitted matches everything. So `*` is omitted, never emitted, and a
  permission-style `Tool(args)` matcher keeps `Tool` and is reported as
  widened (the helper must filter). A Claude-style `mcp__<server>__<tool>`
  matcher loses its `mcp__` prefix, because Grok's MCP tool names are
  `server__tool`; otherwise the hook would load and never fire.
- No `timeout` is emitted: `HookSpec` has none, and Grok's per-event defaults
  (5 s, 30 s for `UserPromptSubmit`, 600 s for `Stop`/`SubagentStop`/
  `PostToolUse`) are better than a fabricated constant.

### 2.5 Server names

Normalized to what Grok's tool catalog admits (§Context, 07-mcp-servers.md
§What Grok admits), with deterministic `-2`/`-3` suffixes on collision; every
rename is listed in the runbook, together with any `mcp__<old>` or
`MCPTool(<old>…)` rule that can no longer match. Kebab-case harness names, the
only kind the CLI accepts, are unchanged. Names are **not** length-capped: the
64-character budget applies to the `search_tool`/`use_tool` function names, not
to catalog keys (up to 256), and the guide says not to shorten a `server__tool`
key — truncating would also desynchronize a harness's own `mcp__<name>__*`
allow rule from the emitted table name.

### 2.6 `autonomous.gateCommand`

Not projected. A `Stop` hook can keep a turn running, but only exit code 2 or
a `{"decision": "block"}` answer blocks; any other failure fails open, so
wiring an arbitrary gate command as a hook would silently not gate. Named in
the runbook as a documented no-op.

### 2.6a Multi-host dependency ranges (pre-existing defect)

`scaffold()` pinned every *extra* host to `^0.1.1`, which no published
`host-prime-agent` (0.1.0) satisfies, so a multi-host scaffold's `npm install`
failed with ETARGET before this host existed. It now emits `^0.1.0`, matching
the template's primary-host pin, and the multi-host test asserts the range
admits the version in the repo.

### 2.7 Where this departs from the #279 proposal

1. Helper path `.claude/helpers/<name>.cjs` anchored at `$GROK_WORKSPACE_ROOT`,
   not `bin/<name>.cjs` next to the JSON: one helper serves both hosts, and it
   does not depend on the unresolved relative-path question.
2. No explicit hook `timeout` (§2.4).
3. The banner condition is wider: on 1.0.34 project instructions and skills
   are trust-gated too (1.0.17 loaded `AGENTS.md` untrusted).
4. `goal` and `heartbeat` are projected as `/goal` and `/loop`, not only
   disclosed.
5. `AGENTS.md` is byte-identical between the CLI and web UI; the adapter's
   `AGENTS.md` renders the fuller `HarnessSpec` and is not byte-identical with
   the CLI's. `.grok/config.toml` is byte-identical in all three paths for
   local and off MCP; for remote the CLI and web UI additionally carry the
   `Authorization` header that `McpServerSpec` cannot express (§2.3).

## Consequences

- `npx metaharness my-bot --host grok` scaffolds a harness whose MCP server
  and default-deny posture Grok actually loads (verified end to end: 7 rules,
  the server and `AGENTS.md` load after `grok --trust inspect`).
- The generated harness depends on `@metaharness/host-grok`, which must be
  published before `npm install` works in a `--host grok` scaffold (same as
  every new host).
- `published-smoke.yml`'s all-hosts job scaffolds from the *published* CLI, so
  a hard-coded host list turns it red on the merge push and on every daily cron
  until the release ships — that is what happened when prime-agent landed
  (run 31285811635, "Unknown host: prime-agent"). Its loop therefore now reads
  the `Hosts:` line from the published artifact's `--help` (failing if that
  line is missing or has no `claude-code`) and passes the same set to
  `verify-all-hosts.mjs` through `VERIFY_HOSTS`. The repo's own lists still
  name every host, including grok.
- One more adapter to keep propagated (ADR-033 checklist) and verified
  (ADR-046): `verify-all-hosts.mjs --real` gains a zero-cost grok check, and
  the adapter suite runs the real binary when one is installed.
- Grok moves fast (1.0.17 → 1.0.34 in 16 days changed what loads untrusted).
  `VERIFIED_GROK_VERSION` is exported and printed in the runbook; the
  real-binary tests are the drift alarm.

## Alternatives Considered

1. **Compat-only reuse of the claude-code tree.** Rejected: Grok never reads
   `mcpServers` from `.claude/settings.json` (verified), and every compat cell
   can be switched off by user config or environment.
2. **Emit `.mcp.json`.** Rejected: loading depends on the per-user Claude
   import marker, and it is trust-gated anyway.
3. **`install-mcp.sh` running `grok mcp add --scope project`.** Rejected:
   it writes the same `.grok/config.toml` as a manual step.
4. **Translate `mcp__server__*` rules to native `MCPTool(server__*)`.**
   Rejected: both spellings load (verified); verbatim keeps one source of
   truth with `.harness/mcp-policy.json` (ADR-036 §Default-deny composition).
5. **Project `gateCommand` as a `Stop` hook wrapper.** Deferred: needs a
   generated script and execution-level verification (a model session).
6. **Package the harness as a Grok plugin (`grok agent --plugin-dir`).**
   Deferred (#279 open question 4): `--plugin-dir` exists only on
   `grok agent`, not on the root command.

## Test Contract

1. Identity: `HOST_NAME === 'grok'`.
2. TOML: full escaping (control chars, DEL, lone surrogates); stdio/url/env
   shapes; no `type =` line anywhere; duplicate env keys collapse.
3. Strict parse: the golden spec's config and an adversarial spec (names,
   args, env keys/values and rules carrying `]`, `"`, newlines, NUL) parse
   under a TOML 1.0 parser (Python `tomllib`, skipped when absent) into
   exactly one server table and one `[permission]` table.
4. Names: admission-rule normalization, collision suffixes, runbook renames.
5. `[permission]`: verbatim; absent → no table; unknown-tool rules named.
6. Hooks: the 15 events pass; unsupported events/handlers/unsafe helper
   names named; `*` omitted; `Tool(args)` widened and named; no hooks → no file.
7. Instructions/agents/skills: `AGENTS.md` condition and content;
   `.grok/agents` frontmatter sanitized; instruction-only skills with
   `^[a-z0-9-]{1,64}$` names and surrogate-safe 1024-char descriptions.
8. Fail-closed: the banner opens the runbook and names every deny rule; the
   headless line carries one shell-quoted `--deny` per deny rule; a bare spec
   has no banner.
9. Autonomous: each field projected or disclosed; absent optionals never
   fabricated.
10. Golden file byte-equality and two-call determinism.
11. Parity: adapter ↔ CLI `.grok/config.toml` (8 cases); CLI ↔ web UI, every
    file (12 cases).
12. Real binary (skipped without `grok`): untrusted → nothing loads; trusted
    via the trust store and via `GROK_FOLDER_TRUST=0` → 5/5 rules, 3 hooks,
    2 skills, 1 agent, both servers, `AGENTS.md`.
13. Multi-host: every emitted host dependency range admits the version in this
    repo (guards the `^0.1.1` defect in §2.6a).

## Implementation notes (2026-09-19)

- `packages/host-grok`: 47 tests (44 contract + 3 real-binary). Mutation
  check: removing newline escaping (2 fail), adding `type = "http"` (4),
  dropping the banner (3), dropping the `--deny` flags (3), emitting `*` (1),
  keeping a Claude `mcp__` matcher prefix (1), and renaming the table to
  `[permissions]` (14: 12 contract tests, which hard-code the spelling, plus
  both trusted real-binary tests). The real-binary tier is the one that does
  not share the spelling assumption: it asks Grok, which loads 0 rules from
  `[permissions]` without reporting anything.
- Propagation: CLI `HOSTS` + `host-config.ts`, web UI (type, catalog,
  generator, verify, HostGuide), `verify-all-hosts.mjs` (schema + `--real`),
  `verify-harness-live.mjs`, bench (adapter + measured baseline row), build/
  healthcheck/publish scripts, `published-smoke.yml`, codex skill, plugin
  tags, docs.
- `node scripts/verify-all-hosts.mjs --real` on grok 1.0.34: 11/11 schema
  PASS; grok real check PASS (`trusted=true, server=true, AGENTS.md=true,
  7 permission rules loaded`).

## Open questions

1. Hook execution (as opposed to loading) and relative command resolution
   need a model session to prove; not attempted.
2. ADR number: 279 is claimed by PR #288; 280 was free on `main` and in every
   open PR on 2026-09-19. Renumber freely.
3. `RELEASE_ORDER` membership for `host-grok` (added after `host-prime-agent`,
   following #169).

## References

- GH #279 (proposal), GH #160 (Grok as a pipeline stage), GH #168 (Codex hooks
  findings that carry over), PR #332 (autonomous projection convention).
- Grok user guide shipped in the 1.0.34 binary: 05-configuration.md,
  07-mcp-servers.md, 08-skills.md, 10-hooks.md, 12-project-rules.md,
  16-subagents.md, 22-permissions-and-safety.md, 26-config-reference.md.
- ADR-004, ADR-022, ADR-027, ADR-033, ADR-036, ADR-044, ADR-045, ADR-046,
  ADR-246, ADR-247.
