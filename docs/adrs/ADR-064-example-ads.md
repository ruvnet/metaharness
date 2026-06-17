# ADR-064: example-ads — Ad Platforms SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Advertising is one of the largest programmatic domains an agent harness
realistically touches. A single mid-market advertiser may spend millions of
dollars per month across Google and Meta properties; a misplaced mutation
(wrong budget, wrong audience, wrong creative) can burn spend in minutes with
no automatic recovery. At the same time, both platforms expose rich read-only
reporting surfaces — campaign performance, spend breakdowns, audience
insights, attribution data — that are exactly the kind of multi-dimensional
analysis where an agent fan-out (one sub-query per campaign/adset/period)
outperforms a single synchronous API call.

Neither Google nor Meta provides an official, production-ready Node.js client.
The community-maintained `google-ads-api` package (by Opteo, ~v16+) wraps the
gRPC/protobuf interface in TypeScript with GAQL query support and a
`validate_only` mutation gate. Meta's official `facebook-nodejs-business-sdk`
(v25.0.2, June 2026) wraps the Graph API Marketing surface and is the closest
thing to a first-party Node.js client for Meta.

Both platforms sit in a **regulated domain**: digital advertising is governed
by consumer-protection rules (GDPR, CCPA, platform-specific ad policies), and
a harness that makes live mutations — budget changes, creative uploads, audience
targeting modifications — can cause real monetary and reputational harm. This
example therefore defaults entirely to read operations and surfaces the mutation
path only when an operator explicitly sets `ADS_MUTATIONS_ENABLED=true`.

The Google Ads API also distinguishes between **test manager accounts** (safe,
no billing, no impressions, no spend — accessed with the production developer
token but isolated from real accounts) and production accounts. This example
defaults to test-account mode for Google Ads. Meta provides **Sandbox Ad
Accounts** that accept all write calls but never deliver ads or accumulate
spend. Both safety tiers are documented and defaulted.

### Why this example is worth shipping

- Demonstrates how an agent harness handles *two* independent third-party
  platforms under a single slash command, coordinating results before surfacing
  a unified answer.
- The GAQL fan-out pattern (one query per campaign, parallelised across
  accounts) is a canonical example of Tier 2 (cheap-model extraction) feeding
  Tier 3 (frontier reasoning for cross-channel synthesis).
- Advertising is the canonical "regulated but not health/finance" category;
  the safety patterns here are reusable for any domain where a mutation costs
  real money.

---

## Decision

### Chosen SDKs

| Platform | Package | Version (at time of ADR) | Official? |
|---|---|---|---|
| Google Ads | `google-ads-api` | ~v16 (Opteo, community) | No — Google has no official Node.js client |
| Meta Marketing | `facebook-nodejs-business-sdk` | v25.0.2 | Yes (Meta-maintained) |

Both are installed as `dependencies` in the scaffolded project. The `google-ads-api`
package's community status is documented in the generated README; the ADR-051
accuracy rule applies — we do not claim it is an official Google client.

### Headline capability

**Campaign and spend analysis across Google Ads and Meta in a single agent
interaction** — query metrics (impressions, clicks, spend, CPC, ROAS) at
campaign, ad-set, or ad level; cross-channel summary; optional budget-pacing
alert. Read-only by default. Mutations (budget update, campaign pause/enable)
gated behind `ADS_MUTATIONS_ENABLED=true`.

### Agent / skill design

Three specialized agents are scaffolded:

| Agent | File | Tier | Responsibility |
|---|---|---|---|
| `ads-planner` | `agents/ads-planner.md` | Tier 3 (frontier) | Interprets the operator prompt; decides which accounts, date ranges, and metrics to fetch; owns the cross-channel synthesis and final answer |
| `ads-fetcher` | `agents/ads-fetcher.md` | Tier 2 (cheap) | Fan-out worker: executes GAQL queries against Google Ads and `getInsights` calls against Meta; returns raw JSON |
| `ads-verifier` | `agents/ads-verifier.md` | Tier 2 (cheap) | Verification gate: re-reads a sample of the just-fetched data via independent API calls; confirms figures agree before the planner surfaces results; if a mutation was performed, re-reads the mutated resource to confirm the change landed |

Slash command: **`/ads-analyze`**

Invoked as `/ads-analyze [--days N] [--level campaign|adset|ad]`; defaults to
`--days 7 --level campaign`. The planner dispatches the fetcher in parallel
fan-out (one claim per account × platform), the verifier spot-checks a
random sample of rows, then the planner synthesises the cross-channel summary.

### Routing tiers (ADR-026)

| Tier | Model class | Used for |
|---|---|---|
| Tier 1 (WASM booster) | no LLM | JSON normalisation transforms (micro → dollars, field name mapping) |
| Tier 2 (cheap) | Haiku-class | `ads-fetcher` GAQL/Insights fan-out; `ads-verifier` spot-check; pagination cursor walking |
| Tier 3 (frontier) | Sonnet/Opus-class | `ads-planner` cross-channel synthesis; anomaly flagging; budget-pacing narrative |

The Tier 1 booster runs entirely in the scaffold's `bin/scaffold.mjs` normalisation
pipeline — no LLM call needed to convert `cost_micros` to dollars or to rename
Meta's `spend` to a unified `spend_usd` field.

### MCP policy (ADR-022 default-deny)

`.harness/mcp-policy.json` grants exactly:

```json
{
  "version": 1,
  "default": "deny",
  "grants": [
    { "tool": "ads.google.report",          "reason": "GAQL read" },
    { "tool": "ads.google.query",           "reason": "GAQL read" },
    { "tool": "ads.meta.getInsights",       "reason": "Insights API read" },
    { "tool": "ads.meta.getCampaigns",      "reason": "Campaign list read" },
    { "tool": "ads.meta.getAdSets",         "reason": "AdSet list read" },
    { "tool": "ads.google.validate_mutate", "reason": "Dry-run mutation validation only" },
    { "tool": "audit.log",                  "reason": "All calls logged" }
  ],
  "mutation_grants": [
    {
      "tool": "ads.google.mutate",
      "requires_env": "ADS_MUTATIONS_ENABLED",
      "reason": "Live budget/status mutations — opt-in only"
    },
    {
      "tool": "ads.meta.createCampaign",
      "requires_env": "ADS_MUTATIONS_ENABLED",
      "reason": "Live campaign creation — opt-in only"
    },
    {
      "tool": "ads.meta.updateCampaign",
      "requires_env": "ADS_MUTATIONS_ENABLED",
      "reason": "Live campaign update — opt-in only"
    }
  ],
  "audit_log": ".harness/audit.jsonl"
}
```

Every tool call is written to `.harness/audit.jsonl` regardless of grant
status, including the grant decision and timestamp. Denied calls are hard
errors, not silent drops.

### Auth model

#### Google Ads

Credentials are read from environment variables at runtime:

| Env var | Description |
|---|---|
| `GOOGLE_ADS_CLIENT_ID` | OAuth 2.0 client ID (from Google Cloud Console) |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth 2.0 client secret |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | 22-character token from the Google Ads Manager account API Center |
| `GOOGLE_ADS_REFRESH_TOKEN` | Per-user refresh token (obtained via OAuth flow) |
| `GOOGLE_ADS_CUSTOMER_ID` | Target customer / account ID (no hyphens) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Manager account ID, required when accessing sub-accounts |

The `google-ads-api` `GoogleAdsApi` constructor is called with these values
at runtime; they are never written to scaffolded files. Google Ads test accounts
share the same developer token as production but are logically isolated — no
impressions, no billing.

#### Meta Marketing API

| Env var | Description |
|---|---|
| `META_APP_ID` | Facebook App ID (from Meta for Developers) |
| `META_APP_SECRET` | Facebook App Secret |
| `META_ACCESS_TOKEN` | System User access token (long-lived, recommended) or User token |
| `META_AD_ACCOUNT_ID` | Ad Account ID in `act_XXXXXXXXXX` format |

`FacebookAdsApi.init(process.env.META_ACCESS_TOKEN)` is called at runtime.
For sandbox testing, create a Marketing API Sandbox Ad Account via the Meta
for Developers dashboard; no real ads are delivered and no spend accumulates.

No credentials appear in any file written by the scaffold.

### Safety gates

1. **Default read-only**: the MCP policy `default: "deny"` blocks all mutation
   tools unless `ADS_MUTATIONS_ENABLED=true` is set in the environment.
2. **Google Ads `validate_only`**: when the fetcher calls any mutation path,
   it ALWAYS sets `validate_only: true` first; the result is verified; only
   if `ADS_MUTATIONS_ENABLED=true` is the live mutation then attempted.
3. **Meta Sandbox**: the scaffold README instructs operators to set
   `META_AD_ACCOUNT_ID` to a Sandbox account ID during development.
4. **Google Ads Test Accounts**: the README instructs operators to use a test
   manager hierarchy during development; test accounts cannot interact with
   production accounts.
5. **Verification gate (ADR-050)**: the `ads-verifier` agent re-reads a random
   sample of reported metrics via independent API calls and compares figures
   before the planner presents results. If figures disagree by more than 1%
   (floating-point rounding), the verifier flags the discrepancy and halts.
6. **Audit log**: every API call (read or mutation) is written to
   `.harness/audit.jsonl` with timestamp, tool, arguments hash, and response
   status.
7. **Regulated-domain disclaimer**: the README carries a prominent not-for-
   production / not-certified notice (see Consequences).

---

## Consequences

### Positive

- Gives operators a safe, one-command scaffold to start reading their own ad
  performance data without risk of accidental spend.
- The dual-platform fan-out pattern (Google + Meta in parallel) is a realistic
  production workflow that demonstrates swarm coordination concretely.
- The `validate_only` + verifier combination is a transferable pattern for any
  domain where a mutation is expensive to reverse.
- The per-call audit log meets a baseline requirement for ad-platform API
  usage policies (both Google and Meta require that API usage be logged).

### Honest limitations

- `google-ads-api` is a community library (Opteo), not an official Google
  client. Google supports official clients only for Java, .NET, PHP, Python,
  Ruby, and Perl. The community library may lag API version releases.
- Google Ads test accounts do not return real serving metrics
  (impressions, clicks, cost are empty in test environments). The verifier
  will see zeroed metrics in test mode; this is expected and documented.
- Meta Sandbox Ad Accounts do not currently return simulated insights data
  (this feature is listed as "future" in Meta's documentation as of 2026).
  Operators testing the full pipeline must use a real (but low-budget)
  ad account with `ADS_MUTATIONS_ENABLED` left unset.
- OAuth refresh-token generation for Google Ads requires a separate manual
  step (run the OAuth flow); this scaffold does not automate that flow —
  `npm run doctor` links to the relevant documentation.
- The scaffold does not implement Google Ads API version negotiation.
  Operators must pin the `google-ads-api` package version to match their
  approved API version.
- Advantage+ Shopping Campaigns (ASC) and Advantage+ App Campaigns (AAC)
  can no longer be created or updated via the Meta Marketing API v25+
  (May 2026 deprecation). The scaffold's mutation examples do not include ASC/AAC.

### Not-for-production disclaimer

> **This example is illustrative only and is NOT suitable for production
> advertising operations without significant additional engineering, legal
> review, and compliance controls.** It does not constitute certified
> compliance with GDPR, CCPA, Google Ads API Terms of Service, Meta Platform
> Terms, or any other applicable advertising regulation. Budget mutations,
> audience changes, and creative operations made via this scaffold are the
> sole responsibility of the operator. Always test in a sandbox or test account
> before connecting production credentials.
