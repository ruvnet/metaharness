# @metaharness/host-grok

Grok Build (`grok`, xAI's terminal agent; install with
`curl -fsSL https://x.ai/cli/install.sh | bash`) host adapter for
[agent-harness-generator](https://github.com/ruvnet/agent-harness-generator), per
[ADR-280](../../docs/adrs/ADR-280-host-grok.md). Verified against
`grok 1.0.34`.

## What it emits

| HarnessSpec | File | Grok surface |
|---|---|---|
| `mcpServers[]` | `.grok/config.toml` `[mcp_servers.<name>]` | `command` + `args` + `enabled = true` (stdio) or `url` (HTTP, no `type` key); `env` as a sub-table. Same shape `grok mcp add --scope project` writes. |
| `permissions.allow/deny` | `.grok/config.toml` `[permission]` | Claude Code rule strings, verbatim; Grok evaluates `deny` > `ask` > `allow`. |
| `systemPrompt`, `description`, `agents` roster | `AGENTS.md` | Project instructions, plus the `<server>__<tool>` names Grok uses for MCP tools. |
| `agents[]` | `.grok/agents/<name>.md` | Subagent definitions (`name` + `description` frontmatter). |
| `tools[]` | `.grok/skills/<name>/SKILL.md` | Instruction-only skills: `ToolSpec` has no execution binding, so nothing is fabricated (ADR-247 doctrine). |
| `hooks[]` | `.grok/hooks/<harness>.json` | The Claude Code three-level JSON; `command` hooks call the same `.claude/helpers/<name>.cjs` helper as `host-claude-code`, `http(s)://` handlers become `http` hooks. |
| always | `install-grok.md` | Runbook: install, trust, `grok inspect` checklist, headless `--deny` line, and every field that is renamed, widened or not projected. |

## Folder trust (read this)

Grok loads a project's instructions, skills, hooks and `[permission]` rules,
and starts its MCP servers, **only after the folder is trusted**. On a fresh
checkout `grok inspect` reports `projectTrusted: false` and loads none of
them, so an emitted deny-list is inert. The adapter fails closed: the runbook
opens with a trust banner naming every deny rule, and its headless command
repeats each one as a `--deny` flag, which Grok enforces regardless of trust.

```bash
cd my-harness
grok --trust inspect          # records trust, then lists what loaded (no model call)
grok -p '<task>' --deny 'Bash(rm:*)'   # headless: deny flags are always enforced
```

For CI, `GROK_FOLDER_TRUST=0` turns the folder-trust gate off for one process.

## Programmatic use

Normally consumed through `npx metaharness <name> --host grok`. Directly:

```ts
import { adapter } from '@metaharness/host-grok';
const files = adapter.generateConfig(harnessSpec);
// { '.grok/config.toml': '…', 'AGENTS.md': '…', 'install-grok.md': '…', … }
```

## Not projected (named in `install-grok.md`)

- `statusLine`: Grok's status line is user-level only (`[ui.status_line]` in `~/.grok/config.toml`).
- Hooks whose event Grok lacks (`Setup`, `FileChanged`, `PermissionRequest`) or whose handler is `mcp:`/`prompt:`/`agent:`.
- `autonomous.gateCommand` (a `Stop` hook only blocks on exit code 2).
  `maxTurns` → `--max-turns`, `goal` → `/goal … --budget`, `heartbeat` → `/loop` are projected.

## License

MIT — see [LICENSE](LICENSE).
