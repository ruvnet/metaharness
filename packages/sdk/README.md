# @metaharness/sdk

<!-- ruv-seo:start (ADR-356) -->

Typed helpers for writing a harness definition in code: `defineHarness`, `defineAgent`, `defineSkill`, `defineTool`, `defineHook` and `defineMcpServer` validate names, tiers and collisions at define time and return frozen objects.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript, no native build step. Depends on `@metaharness/kernel` (WASM first, native and pure-JS fallbacks).

## Quickstart

```bash
mkdir demo && cd demo && npm init -y >/dev/null
npm install @metaharness/sdk
cat > quickstart.mjs <<'EOF'
import { defineHarness, defineAgent } from '@metaharness/sdk';
const triager = defineAgent({ name: 'triager', systemPrompt: 'You triage support tickets.', tier: 'small' });
const escalator = defineAgent({ name: 'escalator', systemPrompt: 'You decide when to page humans.', tier: 'frontier' });
const h = defineHarness({ name: 'my-bot', description: 'Customer support harness', agents: [triager, escalator] });
console.log(h.name, '->', h.agents.map((a) => `${a.name}:${a.tier}`).join(', '), '| frozen:', Object.isFrozen(h));
try { defineHarness({ name: 'MyBot' }); } catch (e) { console.log('rejected:', e.message); }
EOF
node quickstart.mjs
```

Expected output:

```text
my-bot -> triager:small, escalator:frontier | frozen: true
rejected: harness name must be kebab-case [a-z0-9-], starting with a letter: got "MyBot"
```

**Next:** [`metaharness`](https://www.npmjs.com/package/metaharness) — scaffold a full harness project (host config, tests, manifest) and check it with `harness doctor`.

**Fit:** standalone — no published `@metaharness` package depends on it; `metaharness` scaffolds generate their spec without it. It is an authoring convenience for people who write a harness spec by hand.
<!-- ruv-seo:end -->

## Reference

Convenience helpers for harness authors. Wraps [`@metaharness/kernel`](../kernel-js/) with typed, validated, named definitions so your IDE catches typos before they reach the kernel.

## Use

```js
import {
  defineHarness, defineAgent, defineSkill, defineTool,
  defineHook, defineMcpServer,
} from '@metaharness/sdk';

const triager = defineAgent({
  name: 'triager',
  systemPrompt: 'You triage support tickets.',
  tier: 'small',
});

const escalator = defineAgent({
  name: 'escalator',
  systemPrompt: 'You decide when to page humans.',
  tier: 'frontier',
});

const kbServer = defineMcpServer({
  name: 'kb',
  command: ['npx', '-y', 'my-bot', 'mcp', 'kb'],
});

export default defineHarness({
  name: 'my-bot',
  description: 'Customer support harness',
  agents: [triager, escalator],
  mcpServers: [kbServer],
});
```

## Why use it instead of building HarnessSpec directly

| Without SDK | With SDK |
|---|---|
| Field-name typos compile (e.g. `system_prompt` vs `systemPrompt`) | TypeScript catches |
| Invalid tier passes silently | Throws at define time |
| Two agents named the same → confused dispatch | Throws `agent name collision` |
| Harness name accepts `MyBot` | Enforces kebab-case (npm-publishable) |
| Explicitly empty description | Throws (omitted descriptions remain optional) |

All `define*()` helpers return frozen objects so you can't accidentally mutate them.

## License

MIT
