# ADR-044: Live-LLM Host Verification & Host Capability Coverage Review

**Status**: Proposed
**Date**: 2026-06-16
**Project**: `ruvnet/agent-harness-generator`
**Supersedes**: none
**Related**: ADR-004 (host integration model), ADR-022 (MCP primitive / default-deny), ADR-028 (skew detection & liveness), ADR-037 (DRACO OpenRouter fusion — source of the live transport), ADR-033 (host-github-actions)

---

## Context

Two gaps surfaced in a deep review of all nine `packages/host-*` adapters
against the kernel's `HarnessSpec` contract (`packages/kernel-js/src/types.ts`).

**Gap 1 — verification is shape-only for 8 of 9 hosts.**
`scripts/verify-all-hosts.mjs` proves each host's emitted config is *well-formed*
(valid JSON/TOML, dep present) and runs a real `claude -p` end-to-end **only**
for claude-code, and **only** when the Anthropic `claude` CLI is on PATH. The
other eight hosts — and claude-code on CI — fall back to schema/dep checks.
Nothing proves a generated harness's *content* (system prompt, agent roster,
tool/MCP manifest) is actually usable by a real model, and there is no path that
exercises the non-Anthropic hosts against a live provider at all.

**Gap 2 — adapters under-consume the `HarnessSpec`.**
`HarnessSpec` carries `name, description, systemPrompt, mcpServers, tools,
agents, hooks, permissions, statusLine`. Most adapters emit only a subset.
Several drop load-bearing fields silently, and three contain concrete defects
(below). The specs are populated by the CLI (`manifest.ts`); the loss is at the
adapter layer, so a harness can declare agents/prompt/permissions and have the
host config never reflect them.

## Decision

1. **Add a live-LLM verification tier** — `scripts/verify-harness-live.mjs` —
   that extracts each harness's capability surface from its emitted config and
   validates it against a **real model via OpenRouter** (provider-agnostic, so
   all nine hosts are covered, not just Anthropic). The key is sourced from the
   `OPENROUTER_API_KEY` GCP secret (env first, `gcloud secrets versions access`
   fallback), reusing the live-transport pattern established in ADR-037. No key
   ⇒ status `SKIPPED`, exit 0, so CI without the secret stays green.

2. **Track host capability coverage explicitly** in
   `docs/adrs/REVIEW-PROGRESS.md` and drive it to 100% — CLI hosts first, then
   the web-UI generator. Each fix is a follow-on ADR (ADR-045+) where the change
   is non-trivial, or a direct adapter patch + scoreboard update where it is a
   straightforward field-wiring fix.

## Host capability coverage matrix (baseline, iter 1)

`HarnessSpec` field → does the adapter emit it? ✓ full · ⚠ partial/buggy · ✗ dropped · — N/A for this host.

| Host | systemPrompt | mcpServers | tools | agents | hooks | permissions | statusLine | Baseline |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| claude-code   | ✗ | ✓ | — | ✗ | ⚠¹ | ✓ | ✓ | ~45% |
| codex         | ✗² | ✓ | ✗ | ✗ | — | ✗ | — | ~50% |
| copilot       | ✗³ | ✓ | ✗ | ✗ | — | ✗ | — | ~55% |
| github-actions| ✗⁴ | ✗⁵ | ✗ | ✗ | — | ✓ | — | ~50% |
| hermes        | ✓ | ✓ | ✗ | ✗⁶ | — | ✗ | — | ~60% |
| openclaw      | ✓ | ✓ | ✗ | ✓ | — | ✗ | — | ~60% |
| opencode      | ✗ | ✓ | ✗ | ✗⁷ | — | ⚠⁸ | — | ~40% |
| pi-dev        | ✓ | — | ✓ | ✓ | ✗ | ✗⁹ | — | ~75% |
| rvm           | ⚠ | — | ⚠ | ✗ | — | ⚠¹⁰ | — | ~55% |

### Concrete defects (bug-grade — fix first)

- **⁸ opencode permissions wired to the wrong field.** `opencodeJson()` reads
  `(spec as any).mcpPolicy`, but the kernel field is `spec.permissions`. A
  harness's allow/deny posture is silently never emitted — it always writes
  empty `allow:[]/deny:[]`. (`packages/host-opencode/src/index.ts`)
- **⁷ opencode never emits `.opencode/agents/`** despite its own header comment
  documenting that surface. `spec.agents` is dropped.
- **¹⁰ rvm capability table is always empty.** `generateConfig` calls
  `buildCapabilityTable([])` with a hard-coded empty array, so the entire RVM
  capability-token security model emits nothing regardless of the harness's
  claims. (`packages/host-rvm/src/index.ts`)

### Field-drop findings (capability gaps)

- **¹ claude-code hooks** collapse all 5 handler types (`command|http|mcp_tool|
  prompt|agent`) to `command` only; marked "full mapping lands in iter 3" but
  never completed. `spec.systemPrompt`→`CLAUDE.md`, `spec.agents`→`.claude/
  agents/`, skills/commands are not emitted.
- **² codex** drops `systemPrompt` — Codex reads `AGENTS.md`; the adapter emits
  none.
- **³ copilot** drops `systemPrompt` — could emit `.github/copilot-instructions.md`.
- **⁴/⁵ github-actions** never injects `systemPrompt` into the composite action,
  hard-codes `ANTHROPIC_API_KEY` (should be provider-agnostic / allow OpenRouter),
  and wires no MCP servers into the runner env.
- **⁶ hermes** ignores `spec.agents` in `cliConfigYaml`.
- **⁹ pi-dev** emits no `trust.json`; **rvm** ignores `systemPrompt`/`agents`.

## Definition of "100% coverage"

Tracked in REVIEW-PROGRESS.md. A host reaches 100% when, for every `HarnessSpec`
field the host can represent: (a) the adapter emits it, (b) a unit test asserts
the emission, and (c) `verify-harness-live.mjs` confirms a real model sees the
resulting capability surface. Fields genuinely N/A for a host (e.g. MCP on pi-dev/
rvm by design) are excluded from the denominator and noted, never silently.

## Consequences

- **Positive**: real provider coverage for all hosts at ~$0.0002/host/run;
  capability regressions caught by a live gate, not just a schema gate; the
  scoreboard makes "done" falsifiable.
- **Cost/risk**: live runs spend tokens (bounded: cheap model, 60 max tokens,
  ~$0.0002 each) and require the GCP secret — gated, never committed.
- **Negative**: live verification is non-deterministic; mitigated by asserting on
  a strict JSON envelope and treating only `coherent:true` + capability-count ≥ 1
  as PASS.

## How to amend

Per-host fixes append as ADR-045+ (or direct patch + scoreboard update for
field-wiring). This ADR defines the framework; it is not edited in place once
Accepted.
