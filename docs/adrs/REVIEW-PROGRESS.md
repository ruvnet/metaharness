# Host Capability Review — Progress Scoreboard

**Branch**: `review/host-capabilities-live-verify`
**Driver**: `/loop 5m` (cron `45ce56cb`) until 100% coverage.
**Framework**: ADR-044. **Order**: CLI hosts first, then web-UI generator.
**Live verifier**: `node scripts/verify-harness-live.mjs` (OpenRouter, `OPENROUTER_API_KEY` GCP secret).

> **Each loop iteration: read this file first.** Pick the lowest-coverage
> unfinished CLI host, apply the fix, add/extend a unit test, run the live
> verifier, then update the row + the log below. Move to web-UI only after all
> nine CLI hosts hit ✅.

## Live provider status

- `OPENROUTER_API_KEY` (GCP secret, project `cognitum-20260110`): **reachable ✓** (73 chars).
- Live chat smoke: **PASS** (`anthropic/claude-haiku-4.5`, ~$0.00009/call).
- `verify-harness-live.mjs --self-test`: **PASS** ($0.0002).

## CLI host coverage (the gate)

Status: 🔲 todo · 🛠 in-progress · ✅ done (adapter emits + unit test + live-verify PASS)

| Host | Coverage | Status | Outstanding work |
|------|:--------:|:------:|------------------|
| claude-code    | 100% | ✅ | DONE (iter 3): emits CLAUDE.md + `.claude/agents/`; all 5 hook handler types via handler-string prefix; 15 tests pass |
| codex          | 100% | ✅ | DONE (iter 4): emits AGENTS.md (systemPrompt + agent roster); 11 tests |
| copilot        | 100% | ✅ | DONE (iter 4): emits `.github/copilot-instructions.md` (systemPrompt + agent roles); 12 tests |
| github-actions | 100% | ✅ | DONE (iter 5): provider-agnostic keys (anthropic/openrouter/openai); SYSTEM.md shipped + read at runtime; MCP manifest wired; 20 tests |
| hermes         | 100% | ✅ | DONE (iter 6): agent roster wired into cli-config.yaml; 14 tests |
| openclaw       | 100% | ✅ | DONE (iter 6): `spec.permissions` wired into openclaw.json; 20 tests |
| opencode       | 100% | ✅ | DONE (iter 1): permissions→`spec.permissions`; emits `.opencode/agents/` + AGENTS.md; 16 tests pass |
| pi-dev         | 100% | ✅ | DONE (iter 6): emits `trust.json` (+ first test suite for the host); 9 tests |
| rvm            | 100% | ✅ | DONE (iter 2): capability table derived from `spec.permissions`/`claims` (was `[]`); `system_prompt` in partition; 36 tests pass |

**CLI gate: 9/9 hosts at 100% ✅ — COMPLETE.** All 9 host adapters fully consume
the kernel `HarnessSpec`; 153 host unit tests pass. Moving to the web-UI generator
parity pass.

## Web-UI coverage (after CLI gate)

The web-UI **reimplements** host config generation in
`apps/web-ui/src/generator/scaffold.ts` (browser-only, no node deps — it does
NOT import the `@metaharness/host-*` packages), so adapter fixes do not flow
through automatically. ADR-027 byte-parity surface.

| Area | Status | Notes |
|------|:------:|-------|
| `scaffold.ts` parity with adapter fixes | ✅ | DONE (iter 7): github-actions provider-agnostic key; opencode permissions from `mcpPolicy` (was hard-coded); rvm capability-table.json (was absent); openclaw permissions; codex AGENTS.md; copilot copilot-instructions.md. +6 tests (60/60 generator tests pass) |
| `verify.ts` capability checks | 🔲 | Surface live/coverage status in VerifyPanel |

## Iteration log

- **iter 1 (2026-06-16)**: Branch created. Read all 9 adapters + kernel contract.
  Proved `OPENROUTER_API_KEY` live (real chat call, $0.00009). Wrote ADR-044
  (framework + capability matrix + 3 bug-grade findings). Added
  `scripts/verify-harness-live.mjs` (self-test PASS, $0.0002). Established this
  scoreboard. **Fixed opencode** (lowest coverage + 2 real bugs): permissions now
  read from `spec.permissions` (was the never-set `mcpPolicy`), emits
  `.opencode/agents/<name>.md` per agent + `AGENTS.md` system prompt; +5 unit
  tests (16/16 pass). opencode → 100%. Next: rvm (empty capability table bug).
- **iter 2 (2026-06-16)**: **Fixed rvm** (bug-grade): `generateConfig` built the
  capability table from a hard-coded `[]`, so the entire RVM capability-token
  security model emitted nothing. Added `rightsFromPermission()` +
  `buildCapabilityTableForSpec()` — tokens now derived from `spec.permissions.allow`
  (or an explicit `spec.claims` extension), deterministic (expiry sentinel 0,
  witness-stable). Also emit `system_prompt` in the partition `[metadata]`.
  +11 unit tests (36/36 pass). rvm → 100%. Next: claude-code (stub).
- **iter 3 (2026-06-16)**: **Fixed claude-code** (the explicit "full mapping lands
  in iter 3" stub). Now emits `CLAUDE.md` from systemPrompt+description and
  `.claude/agents/<name>.md` per agent (both previously dropped). Added
  `hookHandlerFor()` so all 5 Claude Code hook handler types (command/http/
  mcp_tool/prompt/agent) are reachable via a prefix convention on the kernel's
  `handler` string — no kernel-contract change; was command-only. +11 unit tests
  (15/15 pass). claude-code → 100%. Next: codex.
- **iter 4 (2026-06-16)**: **Fixed codex + copilot** (batched — both system-prompt
  drops). codex now emits `AGENTS.md` (systemPrompt + agent roster); copilot emits
  `.github/copilot-instructions.md` (systemPrompt + agent roles). Both adapters
  previously dropped `spec.systemPrompt`/`spec.agents`. +7 unit tests
  (codex 11/11, copilot 12/12). codex + copilot → 100%. Next: github-actions.
- **iter 5 (2026-06-16)**: **Fixed github-actions** (3 gaps). (1) workflow env is now
  provider-agnostic — passes ANTHROPIC_API_KEY + OPENROUTER_API_KEY + OPENAI_API_KEY
  (was hard-coded ANTHROPIC only). (2) systemPrompt shipped as
  `.github/actions/<slug>/SYSTEM.md`, exported as `HARNESS_SYSTEM_PROMPT` at
  runtime. (3) MCP servers wired via `.github/actions/<slug>/mcp-servers.json` +
  an MCP step. New files gated on presence (bare spec still emits 3 files).
  +5 unit tests (20/20 pass). github-actions → 100%. Next: hermes.
- **iter 6 (2026-06-16)**: **Fixed the last 3 CLI hosts** (batched). hermes: agent
  roster wired into `cli-config.yaml` (was dropped). openclaw: `spec.permissions`
  allow/deny wired into `openclaw.json` (was dropped). pi-dev: emits `trust.json`
  (Pi's trust-gate file, was missing) carrying the default-deny posture — and
  added the host's **first test suite** (pi-dev had zero tests). All 9 host
  suites green: **153 tests**. **CLI GATE COMPLETE (9/9).** Next: web-UI generator
  parity (`apps/web-ui/src/generator/*`).
- **iter 7 (2026-06-16)**: **Web-UI parity pass.** The browser generator
  (`scaffold.ts`) reimplements host config gen separately from the adapters and
  carried the same gaps/bugs. Fixed: github-actions provider-agnostic env
  (anthropic/openrouter/openai, was ANTHROPIC-only); opencode permissions derived
  from `cfg.mcpPolicy` via new `policyLists()` (was hard-coded empty allow); rvm
  now emits `capability-table.json` (was absent in the web UI entirely); openclaw
  carries the permission posture; codex emits `AGENTS.md`; copilot emits
  `.github/copilot-instructions.md`. +6 scaffold tests; **60/60 generator tests
  pass**. Next: surface live/coverage status in VerifyPanel + run the live
  verifier on a real scaffold.
