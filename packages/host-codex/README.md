# @metaharness/host-codex

<!-- ruv-seo:start (ADR-356) -->
Turns a MetaHarness harness spec into the files the OpenAI Codex CLI reads: an MCP server entry for `~/.codex/config.toml`, the matching `codex mcp add` commands, and an `AGENTS.md`.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript with no native build step; `@metaharness/kernel` is used only for its `HarnessSpec` and `HostAdapter` types.

## Quickstart

```bash
npm install @metaharness/host-codex
```

Save this as `quickstart.mjs` and run `node quickstart.mjs`:

```js
import adapter from '@metaharness/host-codex';

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
host: codex
.codex/config.toml  (4 lines)
install-mcp.sh  (2 lines)
AGENTS.md  (4 lines)
```

**Next:** [`@metaharness/codex`](https://www.npmjs.com/package/@metaharness/codex) — scaffold a complete, doctor-checked harness for this host in one command (`npx @metaharness/codex my-bot`).

**Where it fits:** `npx metaharness new <name> --host codex` adds this package as a dependency of the generated harness, and the generated `__tests__/smoke.test.ts` imports it, so `npm test` in that harness fails if the adapter is missing or broken.
<!-- ruv-seo:end -->

## Reference

[OpenAI Codex CLI](https://developers.openai.com/codex) host adapter for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

Generates the host-specific config a Codex-targeted harness needs:

- `~/.codex/config.toml` with `[mcp_servers.<name>]` tables (note: **TOML, not JSON**)
- `codex mcp add` command lines

## Usage

```js
import adapter from '@metaharness/host-codex';

const config = adapter.generateConfig({
  name: 'my-bot',
  mcpServers: [{ name: 'my-bot', command: ['npx', '-y', 'my-bot', 'mcp'] }],
});
// config['.codex/config.toml'] = '<TOML>'
// config['install-mcp.sh'] = '<shell commands>'
```

## Quirks vs Claude Code (call these out for your users)

1. **TOML not JSON.** Codex config is TOML.
2. **Trusted-project gate.** Project-scoped `.codex/config.toml` is only honored after the project is marked trusted — known footgun ([codex#3441](https://github.com/openai/codex/issues/3441)).
3. **No first-class hooks system.** Codex has no `PreToolUse`/`PostToolUse` analog. Generated harnesses approximate lifecycle events via MCP tool calls.

## License

MIT
