# @metaharness/host-opencode

<!-- ruv-seo:start (ADR-356) -->
Turns a MetaHarness harness spec into the files OpenCode (sst/opencode) reads: `.opencode/opencode.json` with MCP and permission settings, an `AGENTS.md`, and an install runbook.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript with no native build step; `@metaharness/kernel` is used only for its `HarnessSpec` and `HostAdapter` types.

## Quickstart

```bash
npm install @metaharness/host-opencode
```

Save this as `quickstart.mjs` and run `node quickstart.mjs`:

```js
import adapter from '@metaharness/host-opencode';

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
host: opencode
.opencode/opencode.json  (21 lines)
install.md  (30 lines)
AGENTS.md  (6 lines)
```

**Next:** [`@metaharness/opencode`](https://www.npmjs.com/package/@metaharness/opencode) — scaffold a complete, doctor-checked harness for this host in one command (`npx @metaharness/opencode my-bot`).

**Where it fits:** `npx metaharness new <name> --host opencode` adds this package as a dependency of the generated harness, and the generated `__tests__/smoke.test.ts` imports it, so `npm test` in that harness fails if the adapter is missing or broken.
<!-- ruv-seo:end -->

## Reference

> [OpenCode](https://opencode.ai) (sst/opencode) host adapter for
> [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator).
> The 8th host adapter, per [ADR-036](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-036-host-opencode.md).

## What it does

Generates the config files a harness needs to run inside **OpenCode**, the
open-source terminal AI coding agent by SST.

Emits per `adapter.generateConfig(spec)`:

- `.opencode/opencode.json` — the OpenCode 1.x project-scoped config:
  `$schema` anchor, `mcp.servers` registration table, `mcp.permissions`
  allow/deny block
- `install.md` — runbook for `opencode auth login`, model-provider
  selection, and the first-boot smoke

## Schema (OpenCode 1.x)

```json
{
  "$schema": "https://opencode.ai/schema/opencode.json",
  "mcp": {
    "servers": {
      "codeindex": {
        "command": "node",
        "args": ["./dist/mcp-server.js"],
        "env": { "LOG_LEVEL": "info" }
      },
      "remote": {
        "url": "https://example.com/mcp"
      }
    },
    "permissions": {
      "allow": ["mcp__codeindex__*"],
      "deny": ["Bash(rm:*)", "Bash(git push:*)"]
    }
  }
}
```

## Default-deny composition

OpenCode evaluates `mcp.permissions.deny` **before** `allow`. This adapter
copies the harness's `.harness/mcp-policy.json` deny rules verbatim, so the
default-deny posture from [ADR-022](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-022-mcp-primitive.md)
wins through OpenCode's own enforcement gate — no second source of truth.

## Constraints

- **OpenCode 1.0+** — earlier 0.x versions had a different config layout
- A model provider configured (`opencode auth login`)
- `.opencode/opencode.json` is re-read on `:reload`, not hot-edit

## Programmatic use

This adapter is normally consumed via `npx metaharness <name> --host opencode`.
Direct programmatic use:

```ts
import { adapter } from '@metaharness/host-opencode';
const files = adapter.generateConfig!(harnessSpec);
// files === { '.opencode/opencode.json': '...', 'install.md': '...' }
```

## License

MIT — see [LICENSE](LICENSE).
