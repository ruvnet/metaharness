# @metaharness/example-ads

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/example-ads flow: npx @metaharness/example-ads my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — Google Ads + Meta Marketing API harness, campaign/spend analysis read-only by default, mutations gated.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This package does not install the third-party SDK; the scaffold tells you to run `npm install google-ads-api` yourself. This is the `@metaharness/example-ads` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/example-ads my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 17
Manifest: ./my-bot/.harness/manifest.json

@metaharness/example-ads — scaffolded "my-bot" for: claude-code
Wrote 6 bespoke showcase file(s) per project (agents/, .harness/mcp-policy.json, commands/, .env.example).

Next steps:
  cd my-bot && npm install
  npm install google-ads-api
  cp .env.example .env   # then fill in: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, META_ACCESS_TOKEN
  npm run doctor
  # then in your host run:  /ads-report "<your request>"

Read-only / sandbox by default. Re-run with --allow-mutations to enable writes (see README -> Safety).
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

> Multi-agent scaffold for Google Ads + Meta Marketing API — campaign and spend analysis, read-only by default, mutations gated.

> ⚠️ **Illustrative output.** Transcripts, metric values, and validation output shown in this README are representative examples, not captured from a specific run. Actual output depends on your environment, models, credentials, and ad account data. Run the commands to see real results.

> ⚠️ **Not for production advertising operations.** This scaffold is illustrative and educational. It is NOT certified for compliance with GDPR, CCPA, Google Ads API Terms of Service, Meta Platform Terms, or any other advertising regulation. All mutations are the sole responsibility of the operator. Always test with a sandbox / test account before connecting production credentials.

[![npm version](https://img.shields.io/npm/v/%40metaharness%2Fexample-ads?label=%40metaharness%2Fexample-ads)](https://www.npmjs.com/package/@metaharness/example-ads)
[![npm downloads](https://img.shields.io/npm/dm/%40metaharness%2Fexample-ads)](https://www.npmjs.com/package/@metaharness/example-ads)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-blueviolet)](https://github.com/ruvnet/agent-harness-generator)

---

## What it is

`@metaharness/example-ads` is a one-command scaffold that wires a three-agent
harness to **Google Ads** (`google-ads-api`, community library by Opteo) and
**Meta Marketing API** (`facebook-nodejs-business-sdk` v25, official Meta SDK).
Out of the box it can only *read* — campaign lists, spend breakdowns, performance
metrics, cross-channel summaries. Any write operation (budget change, campaign
pause, ad creation) requires an explicit environment-variable opt-in and is
still run through a `validate_only` dry-run before the live call.

### What it is NOT

- Not a production advertising management system.
- Not a replacement for native ad managers (Google Ads UI, Meta Ads Manager).
- Not GDPR / CCPA compliant out of the box.
- Not affiliated with or endorsed by Google or Meta.
- `google-ads-api` is a **community library** — Google has no official Node.js
  client. This scaffold makes that clear in generated code comments.

---

## Features

| Capability | Detail |
|---|---|
| **Campaign spend analysis** | GAQL query for `metrics.cost_micros`, `metrics.impressions`, `metrics.clicks`, `metrics.conversions` at campaign / ad-group level for any date range |
| **Meta Insights fan-out** | `AdAccount.getInsights()` at campaign, adset, or ad level; fields: `spend`, `impressions`, `clicks`, `cpc`, `cpm`, `reach`, `roas` |
| **Cross-channel summary** | Planner agent synthesises Google + Meta results into a unified spend dashboard |
| **Budget-pacing alert** | Detects campaigns on pace to over- or under-spend their daily/lifetime budget |
| **Tiered model routing** | Tier 2 (cheap/fast) for fan-out data extraction; Tier 3 (frontier) for cross-channel synthesis and anomaly narrative |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only the minimum read tools; all mutation tools blocked unless `ADS_MUTATIONS_ENABLED=true` |
| **`/ads-analyze` slash command** | Single entry-point for analysis across both platforms |
| **Three specialised agents** | `ads-planner` (Tier 3), `ads-fetcher` (Tier 2), `ads-verifier` (Tier 2) |
| **Verification gate** | `ads-verifier` re-reads a random sample of metrics independently before the planner surfaces results |
| **All hosts** | `--host` flag scaffolds for `claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`; `--host all` emits every config |
| **Audit log** | Every API call written to `.harness/audit.jsonl` |

---

## Quickstart

```bash
npx @metaharness/example-ads@latest my-ads-bot
cd my-ads-bot
npm install
npm run doctor
```

`npm run doctor` checks that required environment variables are set, that both
SDKs are reachable, and that the MCP policy file is intact.

To scaffold for a different host:

```bash
npx @metaharness/example-ads@latest my-ads-bot --host opencode
# or emit every host config at once:
npx @metaharness/example-ads@latest my-ads-bot --host all
```

---

## Configuration

### Google Ads credentials

| Env var | Where to get it | Required |
|---|---|---|
| `GOOGLE_ADS_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → OAuth 2.0 Client | Yes |
| `GOOGLE_ADS_CLIENT_SECRET` | Same OAuth 2.0 client entry | Yes |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | [Google Ads Manager account](https://ads.google.com/) → Tools → API Center | Yes |
| `GOOGLE_ADS_REFRESH_TOKEN` | Run the OAuth flow; `npm run get-google-token` in the scaffolded project prints instructions | Yes |
| `GOOGLE_ADS_CUSTOMER_ID` | Your Google Ads account ID, no hyphens (e.g. `1234567890`) | Yes |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Manager account ID — required only when accessing sub-accounts via a manager | Conditional |

### Meta Marketing API credentials

| Env var | Where to get it | Required |
|---|---|---|
| `META_APP_ID` | [Meta for Developers](https://developers.facebook.com/) → My Apps → your app → Settings → Basic | Yes |
| `META_APP_SECRET` | Same page | Yes |
| `META_ACCESS_TOKEN` | [Graph API Explorer](https://developers.facebook.com/tools/explorer/) for testing; System User token for production | Yes |
| `META_AD_ACCOUNT_ID` | [Meta Business Manager](https://business.facebook.com/) → Ad Accounts; format: `act_XXXXXXXXXX` | Yes |

Store credentials in a `.env` file (gitignored by the scaffold) or your
preferred secrets manager. Never commit credentials to source control.

### Sandbox / test mode

**Google Ads — test accounts (recommended for development):**
Create a test manager account at [ads.google.com/home/tools/manager-accounts/](https://ads.google.com/home/tools/manager-accounts/)
and use the same developer token as your production account. Test accounts
cannot interact with production accounts and do not serve ads or accumulate
spend. Note: test accounts return empty serving metrics (impressions, cost,
conversions are zero); the verifier agent is aware of this and will not flag
zeroed metrics as discrepancies when `GOOGLE_ADS_TEST_MODE=true` is set.

```bash
GOOGLE_ADS_TEST_MODE=true  # set to acknowledge zero-metric test-account behaviour
```

**Meta Marketing API — Sandbox Ad Accounts:**
In [Meta for Developers](https://developers.facebook.com/) → your app →
Marketing API → Tools → Sandbox Mode, create a Sandbox Ad Account. Set
`META_AD_ACCOUNT_ID` to the sandbox account ID (`act_XXXXXXXXXX`). Sandbox
accounts accept all read/write API calls but never deliver ads or accumulate
spend. As of 2026, sandbox accounts do not return synthetic insights data —
plan to use a real (low-budget) account for end-to-end insights testing.

**Mutation gate:**
By default, `ADS_MUTATIONS_ENABLED` is unset, which means the MCP policy
blocks all write tools at the harness boundary. To enable mutations after
completing your sandbox testing:

```bash
ADS_MUTATIONS_ENABLED=true  # enables budget updates, campaign pause/enable
```

Even with mutations enabled, all mutation calls go through `validate_only`
first. The verifier agent confirms the mutation landed before reporting success.

---

## Usage

### Slash command

```
/ads-analyze [--days N] [--level campaign|adset|ad] [--platform google|meta|both]
```

- `--days` — lookback window in days (default `7`)
- `--level` — granularity (default `campaign`)
- `--platform` — which platform(s) to query (default `both`)

### Representative prompts

```
/ads-analyze --days 30 --level campaign
```

The planner will fan out fetchers for each platform, collect campaign-level
metrics for the last 30 days, run the verifier spot-check, then surface a
cross-channel spend summary.

```
Show me which campaigns are under-pacing their daily budget as of today.
```

The planner interprets this as an analysis task, dispatches the fetcher with
`--days 1 --level campaign`, and applies budget-pacing logic before the
verifier confirms the figures.

```
What was our blended CPC across Google and Meta last week?
```

Cross-channel metrics query; the planner normalises Google's `cost_micros /
clicks` with Meta's `cpc` field before presenting a unified answer.

**With mutations enabled** (`ADS_MUTATIONS_ENABLED=true`):

```
Pause all Google Ads campaigns with a 7-day CPA above $50.
```

The planner identifies candidates via a read query, runs `validate_only`
mutations on each, presents the dry-run results for confirmation, then — only
after the operator confirms — executes the live mutations. The verifier
re-reads each campaign's status to confirm `PAUSED` landed.

---

## Safety

| Control | Default | Override |
|---|---|---|
| Mutations blocked by MCP policy | Blocked (default-deny) | `ADS_MUTATIONS_ENABLED=true` |
| Google Ads `validate_only` pre-check | Always on for any mutation path | Not bypassable from prompts |
| Google Ads test account | Recommended for dev | Set `GOOGLE_ADS_CUSTOMER_ID` to test account ID |
| Meta Sandbox Ad Account | Recommended for dev | Set `META_AD_ACCOUNT_ID` to sandbox `act_` ID |
| Verification gate (re-read before "done") | Always on | Not bypassable from prompts |
| Audit log | Always on (`.harness/audit.jsonl`) | Not bypassable from prompts |
| Secrets in env only | Enforced by scaffold | Never written to scaffolded files |

The audit log records every API call (read or attempted mutation) with
timestamp, tool name, arguments hash, and response status. It is append-only
and not cleared by the harness.

---

## How it works

### Agent pipeline

```
Operator prompt
       │
       ▼
 ads-planner (Tier 3 — frontier model)
   Interprets intent; decides accounts, date range, metrics, level.
   Dispatches ads-fetcher in parallel fan-out.
       │
       ▼
 ads-fetcher × N (Tier 2 — cheap/fast model)
   One claim per (platform × account).
   Google: customer.report() with GAQL.
   Meta:   AdAccount('act_...').getInsights([...fields], {date_preset}).
   Returns raw JSON rows.
       │
       ▼
 Tier 1 WASM booster (no LLM)
   Normalises cost_micros → spend_usd, unifies field names,
   deduplicates pagination cursors.
       │
       ▼
 ads-verifier (Tier 2 — cheap/fast model)
   Re-reads a random 10% sample via independent API calls.
   Compares figures; flags if delta > 1%.
   If GOOGLE_ADS_TEST_MODE=true, accepts zero metrics as valid.
   On mutation paths: re-reads the mutated resource to confirm change landed.
       │
       ▼
 ads-planner (Tier 3 — frontier model)
   Synthesises cross-channel summary.
   Applies budget-pacing logic.
   Surfaces final answer only after verifier clears.
```

### MCP policy — granted tools

The `.harness/mcp-policy.json` grants exactly these tools by default:

- `ads.google.report` — GAQL report query (read)
- `ads.google.query` — direct GAQL query (read)
- `ads.meta.getInsights` — Insights API (read)
- `ads.meta.getCampaigns` — campaign list (read)
- `ads.meta.getAdSets` — ad-set list (read)
- `ads.google.validate_mutate` — dry-run validation only (never live)
- `audit.log` — all calls logged

Mutation tools (`ads.google.mutate`, `ads.meta.createCampaign`,
`ads.meta.updateCampaign`) are listed in `mutation_grants` and are
hard-blocked unless `ADS_MUTATIONS_ENABLED=true` is present in the
environment. Denied calls are hard errors with audit-log entries, not
silent drops.

### Routing tiers

| Tier | What runs there | Model class |
|---|---|---|
| Tier 1 (WASM, no LLM) | `cost_micros` → `spend_usd` normalisation; field unification | None |
| Tier 2 (cheap) | `ads-fetcher` fan-out; `ads-verifier` spot-checks; pagination cursor walking | Haiku-class |
| Tier 3 (frontier) | `ads-planner` synthesis; anomaly narrative; budget-pacing analysis | Sonnet/Opus-class |

---

## Links

- [google-ads-api on npm](https://www.npmjs.com/package/google-ads-api) (community library by Opteo)
- [google-ads-api on GitHub](https://github.com/Opteo/google-ads-api)
- [Google Ads API official docs](https://developers.google.com/google-ads/api/docs/start)
- [Google Ads API test accounts](https://developers.google.com/google-ads/api/docs/best-practices/test-accounts)
- [Google Ads API testing best practices](https://developers.google.com/google-ads/api/docs/best-practices/testing)
- [facebook-nodejs-business-sdk on npm](https://www.npmjs.com/package/facebook-nodejs-business-sdk)
- [facebook-nodejs-business-sdk on GitHub](https://github.com/facebook/facebook-nodejs-business-sdk)
- [Meta Marketing API docs](https://developers.facebook.com/docs/marketing-apis/)
- [Meta Marketing API Sandbox Ad Accounts](https://developers.facebook.com/ads/blog/post/v2/2016/10/19/sandbox-ad-accounts/)
- [ADR-064 — this design record](https://github.com/ruvnet/agent-harness-generator/tree/main/docs/adrs/ADR-064-example-ads.md)
- [ADR-051 — examples program contract](https://github.com/ruvnet/agent-harness-generator/tree/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)

---

## License

MIT. Built on [metaharness](https://www.npmjs.com/package/metaharness).
