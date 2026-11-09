# @metaharness/host-pi-dev

<!-- ruv-seo:start (ADR-356) -->
Turns a MetaHarness harness spec into a pi.dev coding-agent extension, `AGENTS.md`, `SYSTEM.md` and `trust.json`. There is no MCP wiring; the Pi agent does not use MCP by design.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript with no native build step; `@metaharness/kernel` is used only for its `HarnessSpec` and `HostAdapter` types.

## Quickstart

```bash
npm install @metaharness/host-pi-dev
```

Save this as `quickstart.mjs` and run `node quickstart.mjs`:

```js
import adapter from '@metaharness/host-pi-dev';

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
host: pi-dev
pi-extension/src/index.ts  (10 lines)
AGENTS.md  (8 lines)
SYSTEM.md  (1 lines)
trust.json  (12 lines)
```

**Next:** [`@metaharness/pi-dev`](https://www.npmjs.com/package/@metaharness/pi-dev) — scaffold a complete, doctor-checked harness for this host in one command (`npx @metaharness/pi-dev my-bot`).

**Where it fits:** `npx metaharness new <name> --host pi-dev` adds this package as a dependency of the generated harness, and the generated `__tests__/smoke.test.ts` imports it, so `npm test` in that harness fails if the adapter is missing or broken.
<!-- ruv-seo:end -->

## Reference

[pi.dev coding agent](https://pi.dev/) host adapter for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

> **NOT Inflection's Pi.ai consumer chatbot.** This is the [badlogic/pi-mono](https://github.com/badlogic/pi-mono) Pi coding agent — a minimal CLI agent harness.

Generates the host-specific files a Pi-targeted harness needs:

- A Pi extension TypeScript source that registers each kernel tool via `pi.registerTool({...})`
- `AGENTS.md` with the harness's agent roster
- `SYSTEM.md` with the harness's system prompt

## Critical design note

Pi explicitly ships with **no MCP**. From the README's "What we didn't build" section: *"No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."*

This adapter generates a Pi extension (TypeScript module installed via `pi install npm:@your-org/your-harness`), NOT MCP config. The kernel's MCP primitives are bypassed; the tool registry is exposed via `pi.registerTool({...})` calls.

## Usage

```js
import adapter from '@metaharness/host-pi-dev';

const config = adapter.generateConfig({
  name: 'my-bot',
  tools: [{ name: 'remember', description: 'Store a memory', inputSchema: {} }],
  agents: [{ name: 'coder', systemPrompt: 'You are a coder.' }],
});
// config['pi-extension/src/index.ts'] = '<TypeScript>'
// config['AGENTS.md'] = '<markdown>'
// config['SYSTEM.md'] = '<markdown>'
```

## License

MIT
