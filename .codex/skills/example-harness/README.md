# example-harness (Codex skill)

One-command scaffolding from the 18 **published** `@metaharness/*` example
packages — the fastest path from a use-case to a working harness, no
template/host flags to remember.

Where [`create-harness`](../create-harness/) walks the full wizard, this
skill maps a use-case straight onto a published npm wrapper. Each wrapper
shells out to `metaharness@latest` with the correct `--template` + `--host`
flags, so the result is byte-identical to the full CLI invocation.

## Install

```bash
mkdir -p ~/.codex/skills/example-harness
curl -fsSL https://raw.githubusercontent.com/ruvnet/agent-harness-generator/main/.codex/skills/example-harness/skill.toml \
  -o ~/.codex/skills/example-harness/skill.toml
```

No MCP server needed — the wrapper packages run via `npx`.

## Use

```
/example-harness
```

Codex prompts for the package + a directory name, then runs:

```bash
npx --yes @metaharness/<package>@latest <name>
```

## The 18 packages

**Host integrations** (scaffold a workspace wired for one runtime)

| Package | Scaffolds |
|---|---|
| `@metaharness/claude-code` | Claude Code workspace + plugin |
| `@metaharness/codex` | OpenAI Codex |
| `@metaharness/hermes` | Hermes cli-config |
| `@metaharness/pi-dev` | pi.dev AGENTS.md |
| `@metaharness/openclaw` | OpenClaw `.openclaw/` |
| `@metaharness/rvm` | RVM deployment partition |
| `@metaharness/copilot` | VSCode / Copilot `mcp.json` |
| `@metaharness/opencode` | OpenCode `.opencode/` |
| `@metaharness/github-actions` | GitHub Actions CI/CD (non-interactive) |

**Vertical workflows** (ready-made multi-agent pods)

| Package | Scaffolds |
|---|---|
| `@metaharness/devops` | incident response |
| `@metaharness/research` | multi-source dossier |
| `@metaharness/trading` | quant trading (paper-by-default) |
| `@metaharness/support` | customer support |
| `@metaharness/legal` | contract redline (drafts only) |
| `@metaharness/coding` | engineering pod |
| `@metaharness/education` | tutor pod |
| `@metaharness/sales` | sales pipeline pod |
| `@metaharness/gaming` | game-design pod |
| `@metaharness/repo-maintainer` | OSS repo maintainer |

## After scaffolding

```bash
cd <name> && npm install
npx harness doctor      # health-check
npx harness validate    # full umbrella gate
```

Every scaffold ships a `.claude-plugin/plugin.json`, so it also loads as a
Claude Code plugin: `claude -p --plugin-dir <name> "..."`.

Per-package deep-dive gists: see
[`examples-packages/GISTS.md`](https://github.com/ruvnet/agent-harness-generator/blob/main/examples-packages/GISTS.md).
