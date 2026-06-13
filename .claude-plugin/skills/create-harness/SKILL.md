---
name: create-harness
description: Scaffold your own focused AI agent harness — pick host (Claude Code, Codex, pi.dev, Hermes), template, agents, skills, and ship a npm-publishable harness with its own npx CLI. Use when a user asks to "create my own agent harness", "scaffold a harness", "make a custom Claude Code plugin like ruflo", or "build a vertical AI assistant for X".
---

# create-harness

This skill scaffolds an AI agent harness — your own focused, branded harness with its own `npx <name>` CLI, MCP server registration, memory namespace, learning loop, and marketplace identity.

## When to use this skill

Use this skill when the user wants any of:

- A custom MCP-server-backed AI assistant (legal, trading, support, ops, …)
- A Claude Code plugin that bundles their own agents/skills/prompts
- A Codex skill that wraps a kernel + tools
- A pi.dev extension or Hermes agent runtime config
- A standalone npm package they can `npm publish` under their own scope

## How to invoke

```
/create-harness
```

The skill asks for:

1. **Harness name** (kebab-case, e.g. `legal-redline`)
2. **Description** (one line)
3. **Host(s)** — Claude Code, Codex, pi.dev, Hermes (multi-select)
4. **Template** — `minimal` (default), `vertical:trading`, `vertical:support`, `vertical:devops`, `vertical:legal`, `vertical:research`, or `eject-from-ruflo`
5. **Memory backend** — AgentDB (default), SQLite-only, in-memory
6. **Routing strategy** — 3-tier (default) or single-tier
7. **Marketplace** — independent (no ruflo branding) or powered-by

## Under the hood

Calls `npx create-agent-harness <name>` with the user's choices, copies the chosen template into the current directory, runs the post-generation smoke test, and emits a `.harness/manifest.json` so future updates can `harness upgrade` cleanly (copier-style regenerate-diff-merge).

## Outputs

| File | Purpose |
|---|---|
| `package.json` | The harness's npm package, ready to `npm publish` |
| `bin/<name>.js` | The CLI binary your users invoke |
| `.claude/settings.json` (if Claude Code host) | MCP + hooks wiring |
| `.codex/config.toml` (if Codex host) | MCP table in TOML |
| `AGENTS.md` + `SYSTEM.md` (if pi.dev host) | Pi extension instructions |
| `cli-config.yaml` (if Hermes host) | Hermes runtime config |
| `.harness/manifest.json` | Generator state — drives drift detection (ADR-008) |
| `witness.json` | Ed25519-signed provenance manifest (ADR-011) |

## After scaffolding

The user can:

```bash
cd <name>
npm install
npm test
npm publish              # ship their harness to npm
# their users: npx <name> init
```

## Notes for the model

- This is a deterministic operation — defer to `create-agent-harness` for the actual file creation, do NOT generate harness file contents yourself
- The witness manifest is required — do not skip it
- If the user asks for "ruflo for X" or "my own ruflo", recommend `vertical:<X>` templates first and offer `minimal` as the fallback
- Multi-host is supported but increases the harness's surface area — recommend single-host for first-time users unless they explicitly need multi-host
