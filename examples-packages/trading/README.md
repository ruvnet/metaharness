# MetaHarness: trading vertical

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/trading flow: npx @metaharness/trading my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — quant trading harness with non-bypassable risk gate, paper-by-default.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/trading` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/trading my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 27
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  cd my-bot && npm install
  harness doctor   # confirm risk gate + paper-trading defaults are wired
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A ready-made multi-agent scaffold for quantitative trading workflows on top of Claude Code. Ships a research → strategy → risk → execution pipeline with a non-bypassable risk gate and paper-trading defaults, so you can iterate on signals and backtests without accidentally wiring real capital. Intended for quants, algo-trading hobbyists, and trading-platform integrators who want a sane starting point. It does NOT include broker credentials, a live order router, or any market-data subscription — bring your own broker adapter when you're ready to flip from paper to live.

## Quickstart

```bash
npx @metaharness/trading@latest my-bot
cd my-bot && npm install && harness doctor
```

`harness doctor` verifies the risk gate is wired, the paper-trading flag is on, and Claude Code can see the bundled MCP servers.

## What you get

- `agents/researcher.md` — market-data and news ingestion, Tier 2 (haiku)
- `agents/strategist.md` — signal generation and feature engineering, Tier 3 (sonnet)
- `agents/risk-officer.md` — position sizing, VaR/CVaR checks, circuit breakers, Tier 3 (opus) — non-bypassable
- `agents/executor.md` — order construction and paper-broker dispatch, Tier 2 (haiku)
- `agents/backtester.md` — walk-forward backtests with cost models, Tier 3 (sonnet)
- `mcp/` — pre-wired MCP servers for market data (OHLCV), paper broker, and a risk-policy server
- `.claude/settings.json` — `PAPER_TRADING=true`, `RISK_GATE=required`, deny-list on any live-order tool until risk-officer signs the trade
- `policies/risk.yaml` — editable position limits, max drawdown, per-symbol exposure caps

## Advanced

Run the bundled doctor to confirm the gate is enforced:

```bash
$ harness doctor
[ok]  paper-trading flag: true
[ok]  risk-officer agent present
[ok]  deny-list blocks: broker.live.placeOrder, broker.live.cancelOrder
[ok]  mcp/market-data reachable
```

Validate the policy file before each session:

```bash
$ harness validate policies/risk.yaml
policies/risk.yaml: valid
  max_position_pct: 5
  max_drawdown_pct: 15
  per_symbol_cap_usd: 10000
```

Drive the harness headlessly from a CI job or a research notebook:

```bash
claude -p --plugin-dir my-bot \
  "Backtest a mean-reversion signal on SPY 2020-2024 with 5bps slippage. Run risk-officer review before reporting PnL."
```

Flip to live only after replacing `mcp/paper-broker` with your broker adapter and editing `.claude/settings.json` to remove the live-order deny rule. The risk-officer agent must still co-sign.

## FAQ

**Q: Can I actually place real orders with this?**
A: Not by default. The scaffold ships with `PAPER_TRADING=true` and a deny-list that blocks every `broker.live.*` tool until you explicitly remove it. Even then, the risk-officer agent must approve each order; that gate is not bypassable from prompts.

**Q: Where does market data come from?**
A: The bundled `mcp/market-data` server is a thin adapter. By default it reads from a local CSV cache under `data/`. Drop in your own Polygon, Alpaca, or IBKR adapter by editing `mcp/market-data/index.mjs` — the interface is documented in `mcp/market-data/README.md`.

**Q: How do I add a new strategy?**
A: Add a markdown spec under `strategies/`, then ask the strategist agent to implement it. The backtester agent will auto-pick it up. No code changes to the harness itself are needed.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/fa8db9614701ebde371cdd327031537e
