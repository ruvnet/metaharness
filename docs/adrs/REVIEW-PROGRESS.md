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
| claude-code    | ~45% | 🔲 | emit CLAUDE.md (systemPrompt), `.claude/agents/`, all 5 hook handler types |
| codex          | ~50% | 🔲 | emit AGENTS.md (systemPrompt), agents |
| copilot        | ~55% | 🔲 | emit `.github/copilot-instructions.md` (systemPrompt) |
| github-actions | ~50% | 🔲 | inject systemPrompt into action, provider-agnostic key, wire MCP into runner |
| hermes         | ~60% | 🔲 | wire `spec.agents` into cli-config.yaml |
| openclaw       | ~60% | 🔲 | wire `spec.permissions`; per-skill SKILL.md |
| opencode       | 100% | ✅ | DONE (iter 1): permissions→`spec.permissions`; emits `.opencode/agents/` + AGENTS.md; 16 tests pass |
| pi-dev         | ~75% | 🔲 | emit `trust.json` |
| rvm            | ~55% | 🔲 | **BUG**: capability table built from empty array; wire claims; systemPrompt |

**CLI gate: 1/9 hosts at 100%.** Next: rvm (bug-grade empty capability table) or claude-code (stub).

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
