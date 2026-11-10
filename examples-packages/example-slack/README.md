# @metaharness/example-slack

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/example-slack flow: npx @metaharness/example-slack my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness Slack SDK showcase — channel triage, scoped-token notify, and a /triage slash-command bot wired to @slack/web-api + @slack/bolt.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This package does not install the third-party SDK; the scaffold tells you to run `npm install @slack/web-api` yourself. This is the `@metaharness/example-slack` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/example-slack my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 17
Manifest: ./my-bot/.harness/manifest.json

@metaharness/example-slack — scaffolded "my-bot" for: claude-code
Wrote 6 bespoke showcase file(s) per project (agents/, .harness/mcp-policy.json, commands/, .env.example).

Next steps:
  cd my-bot && npm install
  npm install @slack/web-api
  cp .env.example .env   # then fill in: SLACK_BOT_TOKEN
  npm run doctor
  # then in your host run:  /slack-triage "<your request>"

Read-only / sandbox by default. Re-run with --allow-mutations to enable writes (see README -> Safety).
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

> Channel triage, scoped-token notify, and a `/triage` slash-command bot — pre-wired to `@slack/web-api` + `@slack/bolt`, safe by default, runnable on every metaharness host in one command.

> **Illustrative output.** The agents in this scaffold produce classifications and draft messages based on your Slack channel history. All output is for demonstration purposes. No messages are sent unless you explicitly opt in with `--allow-send` and `HARNESS_ALLOW_SEND=true`. This is not a production-ready application and has not been audited for compliance with Slack's Terms of Service or any regulated-industry data requirements.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-slack?label=%40metaharness%2Fexample-slack)](https://www.npmjs.com/package/@metaharness/example-slack)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-slack)](https://www.npmjs.com/package/@metaharness/example-slack)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-blueviolet)](https://github.com/ruvnet/agent-harness-generator)

---

## Intro

`@metaharness/example-slack` scaffolds a complete agent harness wired to the official Slack Node.js SDK. It demonstrates three things:

1. **Channel triage** — agents read your Slack channel history, classify messages by urgency (HIGH / MED / LOW), and produce a structured report. They never post automatically.
2. **Scoped-token notify** — with an explicit opt-in flag, the harness posts a summary to a nominated channel using the narrowest possible `chat:write` scope.
3. **Slash-command bot** — a `/triage` command handled by `@slack/bolt` triggers the triage pipeline on demand from inside Slack and responds ephemerally to the invoking user.

**What this is not.** It is not a production Slack bot, not a Slack App Directory listing, and not a data-pipeline replacement. It is the smallest useful starting point for building a Slack-integrated agent harness.

---

## Features

| metaharness capability | How this example shows it |
|---|---|
| **Tiered model routing** | Haiku (cheap) for message collection and notification drafts; Sonnet (frontier) for urgency classification and send/verify decisions |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only `api.test`, `conversations.list`, `conversations.history`, `users.info`, `fs_read` (harness paths only), and `audit_log`; `chat.postMessage` is behind an explicit opt-in |
| **Slash command** | `/triage` — registered via `@slack/bolt`; runs the full pipeline and responds ephemerally |
| **Specialized agents** | ChannelReader (read-only, Tier 2), TriagePlanner (classification, Tier 3), NotifyExecutor (draft + guarded send, Tier 2/3) |
| **Verification gate** | After any `chat.postMessage`, NotifyExecutor reads back the channel with `conversations.history` and asserts the message `ts` is present before reporting done |
| **All 9 hosts** | `--host all` emits config for `claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm` via the metaharness CLI + `@metaharness/host-<id>` adapters |

---

## Quickstart

```bash
npx @metaharness/example-slack@latest my-slack-bot
cd my-slack-bot && npm install && npm run doctor
```

`npm run doctor` validates that Node is ≥ 20, that required env vars are present (or prints which ones are missing), that the `.harness/mcp-policy.json` is well-formed, and that `api.test` resolves successfully against the Slack API.

To scaffold for a specific host:

```bash
npx @metaharness/example-slack@latest my-slack-bot --host pi-dev
```

To scaffold for every supported host at once:

```bash
npx @metaharness/example-slack@latest my-slack-bot --host all
```

---

## Configuration

### Environment variables

Copy `.env.example` to `.env` and fill in the values. Never commit `.env`.

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-…`). Obtain from api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token after installing the app to a workspace. |
| `SLACK_SIGNING_SECRET` | Yes | Request signing secret. Obtain from api.slack.com/apps → Basic Information → Signing Secret. Used by Bolt to verify every incoming request. |
| `SLACK_APP_TOKEN` | Yes (Socket Mode) | App-level token (`xapp-1-…`). Obtain from api.slack.com/apps → Basic Information → App-Level Tokens. Requires the `connections:write` scope. |
| `SLACK_NOTIFY_CHANNEL` | Only with `--allow-send` | The channel ID (e.g. `C0123ABC`) to post summaries to. Find the ID in Slack by right-clicking a channel → View channel details → bottom of the About tab. |
| `HARNESS_ALLOW_SEND` | No (default: false) | Set to `true` to unlock `chat.postMessage`. Both this variable AND the `--allow-send` CLI flag must be set for any message to be posted. |

### Required OAuth bot scopes

Add these under api.slack.com/apps → OAuth & Permissions → Bot Token Scopes:

- `channels:read` — list public channels
- `channels:history` — read message history
- `users:read` — resolve display names
- `commands` — receive slash commands (added automatically when you save a slash command)

Add this scope only when you are ready to enable sending:

- `chat:write` — post messages (opt-in only)

### How to get credentials

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App" → "From scratch".
2. Give it a name and pick a **development workspace** (not your production workspace).
3. Under "Socket Mode", enable Socket Mode and generate an App-Level Token with the `connections:write` scope. Copy this as `SLACK_APP_TOKEN`.
4. Under "OAuth & Permissions", add the bot scopes listed above, then click "Install to Workspace". Copy the Bot User OAuth Token as `SLACK_BOT_TOKEN`.
5. Under "Basic Information", copy the Signing Secret as `SLACK_SIGNING_SECRET`.
6. Under "Slash Commands", create `/triage` pointing to your app (Socket Mode handles routing automatically).

### Safe development without a test workspace

Slack has no separate "test-key" credential type. The recommended safe-development approach is:

- Use a **dedicated free Slack workspace** created solely for development. The harness operates on whichever workspace the bot is installed in, so a dev-only workspace provides full isolation.
- **Socket Mode** (`socketMode: true`) connects over an outbound WebSocket — no public URL, no ngrok, no firewall changes required. This is the default in the scaffold.
- The **`api.test`** method (called by `npm run doctor`) verifies API connectivity without any scopes or side effects.
- Optionally, enroll in the [Slack Developer Program](https://api.slack.com/developer-program) (free, identity-verified) to provision an **Enterprise Developer Sandbox** — an isolated org environment that mirrors all Slack Enterprise features.

---

## Usage

### From the command line (stdio mode)

```bash
# Triage the last 4 hours of messages across all joined public channels
npm run triage

# Triage a specific channel (by ID)
npm run triage -- --channel C0123ABC --hours 8

# Triage and post the summary (requires HARNESS_ALLOW_SEND=true and --allow-send)
HARNESS_ALLOW_SEND=true npm run triage -- --allow-send --channel C0123ABC
```

### From inside Slack (slash command)

In any channel where the bot is present:

```
/triage
```

The bot responds ephemerally (visible only to you) with a priority-grouped triage report. It never posts to the channel.

```
/triage channel:#incidents hours:12
```

Scope the triage to a specific channel and time window.

### Representative natural-language prompt (Claude Code / Hermes / etc.)

```
Triage the last 6 hours of messages in #support and #incidents.
Classify each message HIGH, MED, or LOW urgency and give a one-line reason.
Do not post anything to Slack — just show me the report.
```

---

## Safety

- **No messages are sent by default.** The default scopes include only read operations. `chat.postMessage` is not called unless both `HARNESS_ALLOW_SEND=true` and `--allow-send` are set.
- **Secrets are ENV-only.** The scaffold never writes `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, or `SLACK_APP_TOKEN` into any file. `.env` is listed in the generated `.gitignore`.
- **Signing secret verification.** Every incoming request to the Bolt listener is verified against `SLACK_SIGNING_SECRET` before dispatch. Requests with invalid or missing signatures are rejected.
- **Least-scope OAuth.** The bot requests only the four scopes it needs: `channels:read`, `channels:history`, `users:read`, `commands`. The `chat:write` scope is not added to the app manifest until you explicitly enable sending.
- **Verification gate.** When `--allow-send` is active, NotifyExecutor calls `conversations.history` after posting to confirm the message landed. If the read-back fails, the harness reports an error — it does not silently assume success.
- **Rate-limit awareness.** `conversations.history` is rate-limited to 1 request per minute for new non-Marketplace apps (Slack change, May 2025). The ChannelReader agent uses cursor-based pagination with built-in exponential backoff. Do not run the harness at high frequency against large channels.
- **Not for production.** This example is a demonstrative scaffold. It is not hardened for production deployment, has not undergone a Slack security review, and is not certified for regulated industries or workspaces subject to data-retention policies.

---

## How it works

### Agents

```
Coordinator (hierarchical)
├── ChannelReader   [Tier 2 — Haiku]
│     calls: conversations.list, conversations.history, users.info
│     never writes; returns raw message objects
├── TriagePlanner   [Tier 3 — Sonnet]
│     input: raw messages from ChannelReader
│     output: [{channel, ts, user, urgency, reason}] as JSON
│     never writes; never calls Slack API
└── NotifyExecutor  [Tier 2 draft → Tier 3 send/verify decision]
      input: triage report from TriagePlanner
      draft mode (default): prints formatted report to stdout
      send mode (--allow-send): calls chat.postMessage, then
        reads back with conversations.history to verify ts matches
```

### Routing tiers

| Tier | What runs here |
|---|---|
| **1 — no LLM** | Slash-command `ack()`, cursor-pagination loop, `api.test` healthcheck |
| **2 — Haiku** | Raw message collection (ChannelReader), notification draft (NotifyExecutor) |
| **3 — Sonnet** | Urgency classification with structured JSON output (TriagePlanner), send + verification decision (NotifyExecutor when `--allow-send`) |

### MCP policy

`.harness/mcp-policy.json` (default grant):

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

When `HARNESS_ALLOW_SEND=true`, the policy loader appends one additional grant scoped to `SLACK_NOTIFY_CHANNEL` only:

```json
{ "tool": "slack_web_api_call", "methods": ["chat.postMessage"], "channels": ["${SLACK_NOTIFY_CHANNEL}"] }
```

All grant evaluations are written to `.harness/audit.jsonl`.

---

## Links

- [`@slack/web-api` on npm](https://www.npmjs.com/package/@slack/web-api)
- [`@slack/bolt` on npm](https://www.npmjs.com/package/@slack/bolt)
- [Slack Web API reference](https://docs.slack.dev/tools/node-slack-sdk/web-api/)
- [Bolt for JavaScript documentation](https://docs.slack.dev/tools/bolt-js/)
- [Slack OAuth scopes reference](https://api.slack.com/scopes)
- [Slack Developer Sandboxes](https://docs.slack.dev/tools/developer-sandboxes/)
- [Socket Mode guide](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [ADR-056: example-slack design record](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-056-example-slack.md)
- [ADR-051: Third-party SDK showcase examples program](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
