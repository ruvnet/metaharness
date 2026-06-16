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
| github-actions | ~50% | 🔲 | inject systemPrompt into action, provider-agnostic key, wire MCP into runner |
| hermes         | ~60% | 🔲 | wire `spec.agents` into cli-config.yaml |
| openclaw       | ~60% | 🔲 | wire `spec.permissions`; per-skill SKILL.md |
| opencode       | 100% | ✅ | DONE (iter 1): permissions→`spec.permissions`; emits `.opencode/agents/` + AGENTS.md; 16 tests pass |
| pi-dev         | ~75% | 🔲 | emit `trust.json` |
| rvm            | 100% | ✅ | DONE (iter 2): capability table derived from `spec.permissions`/`claims` (was `[]`); `system_prompt` in partition; 36 tests pass |

**CLI gate: 5/9 hosts at 100%.** Next: github-actions (systemPrompt into action + provider-agnostic key + MCP wiring), hermes (agents), openclaw (permissions + per-skill), pi-dev (trust.json).

## Web-UI coverage (after CLI gate)

| Area | Status | Notes |
|------|:------:|-------|
| `apps/web-ui/src/generator/*` parity with adapter fixes | 🔲 | Mirror each host fix into the browser generator |
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
