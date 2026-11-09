# @metaharness/host-openclaw

<!-- ruv-seo:start (ADR-356) -->
Turns a MetaHarness harness spec into the files OpenClaw reads: an `openclaw.json` MCP entry, a workspace `SKILL.md`, and an install script.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript with no native build step; `@metaharness/kernel` is used only for its `HarnessSpec` and `HostAdapter` types.

## Quickstart

```bash
npm install @metaharness/host-openclaw
```

Save this as `quickstart.mjs` and run `node quickstart.mjs`:

```js
import adapter from '@metaharness/host-openclaw';

const files = adapter.generateConfig({
  name: 'my-bot',
  description: 'demo harness',
  mcpServers: [{ name: 'my-bot', command: ['node', './bin/mcp.js'] }],
});
console.log(`host: ${adapter.name}`);
for (const [path, body] of Object.entries(files)) {
  console.log(`${path}  (${body.split('\n').length} lines)`);
}
```

Expected output:

```text
host: openclaw
openclaw.json  (14 lines)
SKILL.md  (9 lines)
install-openclaw.sh  (21 lines)
```

**Next:** [`@metaharness/openclaw`](https://www.npmjs.com/package/@metaharness/openclaw) — scaffold a complete, doctor-checked harness for this host in one command (`npx @metaharness/openclaw my-bot`).

**Where it fits:** `npx metaharness new <name> --host openclaw` adds this package as a dependency of the generated harness, and the generated `__tests__/smoke.test.ts` imports it, so `npm test` in that harness fails if the adapter is missing or broken.
<!-- ruv-seo:end -->

## Reference

[OpenClaw](https://github.com/openclaw/openclaw) host adapter for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

> OpenClaw — Personal AI Assistant. Any OS. Any Platform. The lobster way. 🦞

Generates the per-harness files an OpenClaw-targeted harness needs:

- `openclaw.json` — MCP server snippet to merge into `~/.openclaw/openclaw.json`
- `SKILL.md` — workspace skill (placed at `~/.openclaw/workspace/skills/<name>/SKILL.md`)
- `install-openclaw.sh` — runbook script (idempotent)

## Usage

```js
import adapter from '@metaharness/host-openclaw';

const config = adapter.generateConfig({
  name: 'my-bot',
  description: 'My personal lobster assistant',
  systemPrompt: 'You are a helpful agent.',
  mcpServers: [{ name: 'my-bot', command: ['npx', '-y', 'my-bot', 'mcp'] }],
});
// config['openclaw.json'] = '<JSON>'
// config['SKILL.md'] = '<YAML+markdown>'
// config['install-openclaw.sh'] = '<bash>'
```

## OpenClaw integration surface

| Aspect | Value |
|---|---|
| Install | `npm install -g openclaw@latest` then `openclaw onboard --install-daemon` |
| Main config | `~/.openclaw/openclaw.json` (JSON, not TOML/YAML) |
| Skills | `~/.openclaw/workspace/skills/<name>/SKILL.md` (YAML frontmatter + markdown) |
| First-class tools | browser, canvas, nodes, cron, sessions |
| MCP servers | register under `mcp_servers` in `openclaw.json` |
| Node version | ≥ 22.19 / 24 |
| License | MIT |

## What's different from the other host adapters

| | OpenClaw | Claude Code | Codex | Hermes | pi.dev |
|---|---|---|---|---|---|
| Config format | **JSON** | JSON | TOML | YAML | TypeScript module |
| Hooks system | (none documented) | rich, 5-handler | none | none | none |
| MCP support | yes | yes | yes | yes | **no (by design)** |
| Multi-platform messaging | **yes (built-in)** | no | no | no | no |

OpenClaw is the only host with built-in multi-platform messaging (WhatsApp/Telegram/Slack/Discord). For a harness that needs to push notifications to the user across channels, OpenClaw is the natural fit.

## License

MIT
