# MetaHarness × Claude Code workspace + plugin

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/claude-code flow: npx @metaharness/claude-code my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — Claude Code workspace + plugin scaffold with CLAUDE.md, .claude/, and MCP wiring.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/claude-code` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/claude-code my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 17
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  cd my-bot && npm install
  npm run doctor
  claude -p --plugin-dir . "summarize the repo and propose a first task"
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/host-claude-code`](https://www.npmjs.com/package/@metaharness/host-claude-code) — the adapter that writes this host's config, if you want to generate it from your own code.
<!-- ruv-seo:end -->

## Reference

A one-command scaffold that drops a ready-to-edit Claude Code workspace into a new directory: `CLAUDE.md`, a `.claude/` settings tree, MCP server stubs, and a minimal plugin layout you can load with `claude -p --plugin-dir`. This is the smallest useful starting point for building a Claude Code-hosted agent — not a multi-agent vertical, not a runtime, and not a chat UI. It's the workspace you wish `claude init` produced.

Use this when you want to ship a Claude Code agent that has opinions: custom slash commands, scoped tool permissions, a project-pinned MCP config, and a plugin folder you can iterate on without polluting your global `~/.claude` config.

## Quickstart

```bash
npx @metaharness/claude-code@latest my-bot
cd my-bot && npm install && npm run doctor
```

`harness doctor` validates that Node is recent enough, that the `.claude/` tree is well-formed, that the plugin manifest parses, and that any declared MCP servers resolve. From here you open the folder in your editor and start editing `CLAUDE.md` plus the files under `.claude/`.

## What you get

- `CLAUDE.md` — project-level system prompt with behavioral rules, file-org conventions, and a starter agent routing table.
- `.claude/settings.json` — host-specific Claude Code config: permission allowlist, default model, hook stubs, and MCP server registrations.
- `.claude/commands/` — example custom slash commands (`/plan`, `/review`) you can rename and extend.
- `.claude/agents/` — one minimal subagent definition you can clone for coder/tester/reviewer roles.
- `plugin.json` + `bin/` — a loadable Claude Code plugin manifest so `claude -p --plugin-dir .` picks it up.
- `mcp.json` — pinned MCP server config (stdio transport, no network defaults).
- `package.json` with a `harness` script bound to the metaharness CLI for `doctor` / `validate` / `upgrade`.

## Advanced

```bash
# Sanity-check the scaffold
npm run doctor
# → node: ok (v20.x)
# → .claude/settings.json: ok
# → plugin.json: ok (1 command, 1 agent)
# → mcp.json: 0 servers reachable, 0 errors

# Validate the plugin manifest against the Claude Code schema
npm run validate --plugin
# → plugin.json schema: ok
# → commands/plan.md: frontmatter ok
# → agents/default.md: frontmatter ok

# Load the workspace as a plugin in a one-off Claude Code session
claude -p --plugin-dir . "summarize the repo and propose a first task"
```

You can also pass extra flags through to the underlying metaharness call — anything after the harness name is forwarded:

```bash
npx @metaharness/claude-code@latest my-bot --skip-install --quiet
```

## FAQ

**Q: Is this different from running `claude init`?**
A: Yes. `claude init` writes a single `CLAUDE.md` into an existing repo. This scaffolds a fresh, opinionated workspace: settings, commands, agents, MCP config, and a loadable plugin manifest, all wired together and validated by `harness doctor`.

**Q: Do I need an Anthropic API key to scaffold?**
A: No. Scaffolding is offline. You only need a key when you actually run `claude` against the workspace.

**Q: Can I use this as a Claude Code plugin instead of a workspace?**
A: Yes — that's why `plugin.json` is at the root. Run `claude -p --plugin-dir <path-to-folder>` and the commands and agents register into your session.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/79808ffb89eeb080b1c00bf79fba33e1
