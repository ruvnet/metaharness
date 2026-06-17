# ADR-056: example-slack — Slack SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Slack is the most widely deployed team-communication platform in technical organisations. Its API surface is mature, well-documented, and practically universal as an agent notification and triage target: virtually every engineering team that would evaluate a generated harness already has a Slack workspace. The ability to demonstrate an agent that can read channels, triage messages by urgency, and post a scoped notification — without granting broad write access — is a concrete, immediately useful proof of the harness value proposition.

The platform provides two complementary npm packages maintained by Slack under the `@slack/` scope:

- **`@slack/web-api`** (v7.17.0 as of June 2026) — a typed WebClient wrapping all 200+ Slack REST methods. Import style: `import { WebClient } from '@slack/web-api';`. Instantiate with a token (`xoxb-` for bots, `xoxp-` for user tokens). Suitable for direct, programmatic API calls from agent executor steps.
- **`@slack/bolt`** (v4.7.3 as of June 2026) — an opinionated app framework that wires up slash-command handlers, event listeners, interactive-component callbacks, and the Socket Mode WebSocket transport (no public URL required for local/firewalled environments). Import style: `import { App } from '@slack/bolt';`.

Both packages require Node ≥ 18; this example targets Node ≥ 20 to align with the metaharness baseline.

Slack does not provide a "test-mode key" like Stripe. Its equivalents for safe development are:

1. **A dedicated development workspace** — a free Slack workspace used only for development, isolated from any production channels.
2. **Socket Mode** — `socketMode: true` + `SLACK_APP_TOKEN` (`xapp-1-…`) connects over WebSocket, avoids exposing a public endpoint, and is the recommended local-dev approach.
3. **`api.test`** method — a no-auth, no-scope ping method useful as a connectivity healthcheck with zero side effects.
4. **Read-only scopes by default** — the scaffold grants only `channels:read`, `channels:history`, `users:read`, and `commands`; `chat:write` is an explicit opt-in.
5. **Slack Developer Sandboxes** — Enterprise-tier isolated org environments available through the Slack Developer Program (free enrollment, identity-verified) for full-feature testing without production impact.

This is the Slack-platform entry in the ADR-051 catalog (catalog row 056).

---

## Decision

### Chosen SDK

Primary: **`@slack/web-api`** (WebClient) for all API calls from agent steps.
Framework: **`@slack/bolt`** for the slash-command receiver and Socket Mode listener.
Both are official Slack-maintained packages under the `slackapi` GitHub org; no third-party wrappers are needed.

### Headline capabilities showcased

1. **Channel triage** — read `channels:history` for a set of channels, classify messages by urgency (HIGH / MED / LOW) using an LLM, surface a structured triage report. Never auto-posts.
2. **Scoped-token notify** — with `--allow-send`, post a summary to a nominated channel using `chat.postMessage` with the minimum `chat:write` scope. Gated by explicit opt-in.
3. **Slash-command bot** — a `/triage` slash command registered via `@slack/bolt` that triggers the triage workflow on demand from inside Slack, responds ephemerally to the requesting user, and never writes to channels without `--allow-send`.

### Agent / skill design

Three specialized agents operate under a hierarchical coordinator:

| Agent | Role | Model tier |
|---|---|---|
| **ChannelReader** | Calls `conversations.list` + `conversations.history`; paginates cursor; returns raw message JSON. Read-only. | Tier 2 (Haiku / cheap) |
| **TriagePlanner** | Classifies each message as HIGH / MED / LOW with a `reason` field; groups by channel; scores overall channel heat. Uses structured JSON output. | Tier 3 (Sonnet / frontier) |
| **NotifyExecutor** | Drafts the notification text; if `--allow-send` is set, calls `chat.postMessage`; otherwise prints the draft to stdout and exits. After sending, calls `conversations.history` with `oldest` = now − 5 s to verify the message landed (verification gate). | Tier 2 (Haiku) for draft, Tier 3 for send+verify decision |

The `/triage` slash command is handled by a lightweight Bolt listener (not an agent) that invokes the three-agent pipeline and responds with an ephemeral message. The listener itself is Tier 1 (no LLM; pure dispatch).

### Routing tiers (ADR-026)

| Tier | Handler | What goes here |
|---|---|---|
| 1 | Direct code / no LLM | Slash-command `ack()`, cursor pagination, API healthcheck (`api.test`) |
| 2 | Haiku (cheap) | Raw message collection (ChannelReader), notification draft (NotifyExecutor draft step) |
| 3 | Sonnet (frontier) | Urgency classification with reasoning (TriagePlanner), send+verify decision |

### MCP policy (ADR-022 default-deny)

The scaffolded `.harness/mcp-policy.json` grants exactly:

```json
{
  "version": "1",
  "default": "deny",
  "grants": [
    { "tool": "slack_web_api_call",  "methods": ["api.test", "conversations.list", "conversations.history", "users.info"] },
    { "tool": "slack_bolt_command",  "commands": ["/triage"] },
    { "tool": "fs_read",             "paths": [".harness/**", ".env.example"] },
    { "tool": "audit_log",           "events": ["*"] }
  ]
}
```

`chat.postMessage` is NOT in the default grant. It becomes available only when the harness is started with `HARNESS_ALLOW_SEND=true`, at which point the policy loader appends:

```json
{ "tool": "slack_web_api_call", "methods": ["chat.postMessage"], "channels": ["${SLACK_NOTIFY_CHANNEL}"] }
```

All grant evaluations write an entry to `.harness/audit.jsonl`.

### Auth model

| Credential | Env var | Where to obtain |
|---|---|---|
| Bot OAuth token | `SLACK_BOT_TOKEN` | api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`) |
| Signing secret | `SLACK_SIGNING_SECRET` | api.slack.com/apps → Basic Information → Signing Secret |
| App-level token (Socket Mode) | `SLACK_APP_TOKEN` | api.slack.com/apps → Basic Information → App-Level Tokens → `connections:write` scope (`xapp-1-…`) |
| Notify channel | `SLACK_NOTIFY_CHANNEL` | Slack channel ID (e.g. `C0123ABC`) — only used when `HARNESS_ALLOW_SEND=true` |

Required OAuth bot scopes (minimum, least-privilege):
- `channels:read` — list public channels
- `channels:history` — read message history (rate-limited to 1 req/min for new apps post-May 2025)
- `users:read` — resolve user display names
- `commands` — receive slash commands (added automatically when a slash command is saved)

Optional (opt-in only):
- `chat:write` — post messages; added to the app only when the operator explicitly enables it and sets `HARNESS_ALLOW_SEND=true`

### Safety gates

- **Read-only by default.** The default harness start does not include `chat:write` in the app manifest and does not call `chat.postMessage` under any code path.
- **No auto-send.** Even when `HARNESS_ALLOW_SEND=true`, the NotifyExecutor agent presents the draft for human review via a dry-run print step before posting.
- **Opt-in flag is explicit.** The `--allow-send` CLI flag AND `HARNESS_ALLOW_SEND=true` env var must both be set; one alone is not sufficient.
- **Verification gate (ADR-050).** After any `chat.postMessage` call, the harness reads back the last message in the target channel using `conversations.history` and asserts the `ts` of the sent message is present. If the read-back fails or the message is absent, the harness surfaces an error and does not report "done".
- **Signing secret verification.** The Bolt listener verifies every incoming request signature against `SLACK_SIGNING_SECRET` before dispatching; requests that fail verification are rejected with HTTP 403.
- **Isolated development workspace.** The README strongly recommends pointing `SLACK_BOT_TOKEN` at a dedicated development workspace, not a production one, for all local testing.
- **Socket Mode for local dev.** With `socketMode: true`, no public URL is required and no ingress firewall rules need to be opened; the connection is outbound-only WebSocket, reducing attack surface.

---

## Consequences

### Positive

- Provides a one-command proof that a generated metaharness can safely drive real Slack workspaces from nine different host environments.
- The read-only default means a developer can install and explore the harness in a real (or development) workspace with zero risk of message spam.
- Socket Mode makes the bot immediately runnable on a laptop or a Raspberry Pi without ngrok or a public domain, which aligns with the `pi-dev` host adapter.
- The three-agent design cleanly separates concerns: the ChannelReader never makes decisions, the TriagePlanner never writes, and the NotifyExecutor is the only agent with a write path — and only when explicitly unlocked.
- The `/triage` slash command demonstrates the Bolt framework integration pattern that covers the majority of real-world Slack bot use cases.
- `channels:history` rate-limit change (May 2025, 1 req/min for new non-Marketplace apps) is handled by the ChannelReader agent through cursor-based pagination with built-in backoff, making the harness rate-limit-safe by default.

### Limitations

- **No Slack Marketplace listing.** Socket Mode apps cannot be listed in the Slack App Directory. Organisations that need a distributable app should switch to HTTP mode (public URL or a load balancer) — that configuration is out of scope for this showcase.
- **Slack Developer Sandboxes are Enterprise-only.** The sandbox feature requires either an existing paid Slack plan or identity verification through the Slack Developer Program. Developers on free workspaces should use a dedicated free development workspace instead.
- **`conversations.history` rate limits.** Post-May 2025, new apps face 1 req/min for `conversations.history` outside the Marketplace. The ChannelReader handles this with backoff, but triage over large, high-volume channels will be slow.
- **No test-key isolation.** Unlike Stripe test keys, Slack has no credential-level separation between "test" and "production" calls; the developer workspace pattern is the isolation boundary, and it depends on operator discipline.
- **`chat.postMessage` is irreversible.** Once a message is sent, it cannot be unsent via the API without `chat:delete` (an additional scope). The double-gate (flag + env var) is the primary safeguard.

### Not-for-production disclaimer

This example is an **illustrative SDK showcase**. It is not hardened for production deployment, not audited for Slack's API Terms of Service compliance regarding data retention or enterprise security reviews, and not certified for regulated industries. Do not point it at a workspace containing confidential communications without your organisation's security review.
