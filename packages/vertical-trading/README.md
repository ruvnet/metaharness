# @metaharness/vertical-trading

<!-- ruv-seo:start (ADR-356) -->

A trading vertical pack for MetaHarness: a manifest for a paper-mode-by-default trading harness with circuit breakers, fractional-Kelly sizing and a five-agent pipeline (market watcher, signal generator, risk checker, executor, postmortem).

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript, no native build step. Depends on `@metaharness/vertical-base`.

## Quickstart

```bash
mkdir demo && cd demo && npm init -y >/dev/null
npm install @metaharness/vertical-trading
cat > quickstart.mjs <<'EOF'
import { load } from '@metaharness/vertical-trading';
import { verifyTemplateFilesPresent } from '@metaharness/vertical-base';
const pack = await load();
console.log(pack.manifest.id, '-', pack.manifest.files.length, 'template files,', pack.manifest.vars.length, 'vars');
console.log('files present:', (await verifyTemplateFilesPresent(pack)).ok);
EOF
node quickstart.mjs
```

Expected output:

```text
vertical:trading - 10 template files, 3 vars
files present: false
```

**Next:** [`@metaharness/vertical-base`](https://www.npmjs.com/package/@metaharness/vertical-base) — the contract this pack implements, if you want to build your own.

**Fit:** no working integration yet — `metaharness` parses `--template-package` but does not call its external-template loader, and this tarball ships only `templates/manifest.json`, not the `.tmpl` files the manifest lists (`verifyTemplateFilesPresent` reports them missing). Today it is a manifest you can load and inspect; for a runnable trading scaffold use [`@metaharness/trading`](https://www.npmjs.com/package/@metaharness/trading).
<!-- ruv-seo:end -->

## Reference

Standalone vertical pack for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) — trading harness with paper-mode-default + circuit breakers + fractional-Kelly position sizing.

## What you get

5-agent pipeline:

| Agent | Tier | Role |
|---|---|---|
| `market-watcher` | Haiku | Polls market data; detects regime shifts |
| `signal-gen` | Sonnet | Generates BUY/SELL/HOLD signals from indicators |
| `risk-checker` | Codemod (deterministic) | Vets every signal against position-sizing + circuit-breaker state |
| `executor` | Codemod | Submits orders (or simulates in paper mode) |
| `postmortem` | Sonnet | Daily P&L review + blameless lessons-learned |

Safety defaults:

- **Paper mode unless `RUFLO_TRADE_CONFIRM=YES_LIVE`**
- Circuit breakers: daily P&L > -2%, < 5 consecutive losses, latency < 500ms
- Fractional-Kelly with 0.25 multiplier (never full Kelly)
- `mcp__broker__live_order*` denied by default

## Use

```bash
npx create-agent-harness my-trader --template-package @metaharness/vertical-trading
```

Or programmatically:

```js
import pack from '@metaharness/vertical-trading';
const { manifest, templateRoot } = await pack.load();
// Pass to your scaffolder.
```

## Risk disclosure

Trading carries risk. Past backtest performance does not predict future results. This pack ships defaults that minimize risk in paper mode — verify them yourself before going live. The author and the agent-harness-generator project are not responsible for any losses.

## License

MIT
