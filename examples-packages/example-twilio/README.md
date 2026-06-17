# @metaharness/example-twilio

**MetaHarness scaffold for Twilio — SMS, voice, and WhatsApp agents with test-credential sandbox and Messaging Service scoping**

> **Illustrative output.** This package scaffolds example agent harness code for demonstration purposes. Generated code targets Twilio's test-credential sandbox by default. It is not certified for TCPA compliance, carrier compliance, or production communications without operator review. See [Safety](#safety) below.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-twilio?style=flat-square)](https://www.npmjs.com/package/@metaharness/example-twilio)
[![npm downloads](https://img.shields.io/npm/dw/@metaharness/example-twilio?style=flat-square)](https://www.npmjs.com/package/@metaharness/example-twilio)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org/)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-7c3aed?style=flat-square)](https://github.com/ruvnet/agent-harness-generator)

---

## Intro

`@metaharness/example-twilio` is a one-command scaffold that generates a fully wired MetaHarness agent harness targeting the [Twilio](https://www.twilio.com/) communications platform. Running `npx @metaharness/example-twilio@latest my-bot` produces a project directory containing:

- A three-agent pipeline (planner, executor, verifier) pre-wired to the `twilio` npm SDK
- A `/sms` slash command that drives the full pipeline
- A scoped MCP policy granting exactly the Twilio tools needed (default-deny, audited)
- Tiered model routing — cheap model for extraction and verification, frontier model gated behind `--allow-live`
- A verification gate that reads back the message or call `sid` before reporting success
- Host adapter config for all nine MetaHarness hosts: `claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`

**What it is NOT**: a production-ready messaging application, a TCPA-compliant marketing platform, or a certified carrier integration. It is a starting point — a scaffold you complete, review, and adapt for your use case.

---

## Features

| Capability | Detail |
|---|---|
| **SMS dispatch** | Send via a direct Twilio number or a Messaging Service SID (`MG…`) for pooled, sticky-sender delivery |
| **Outbound voice** | Initiate calls with inline TwiML (`<Say>`, `<Gather>`, `<Record>`) or a TwiML URL |
| **WhatsApp messaging** | Send to `whatsapp:+<E.164>` via the shared Sandbox (`whatsapp:+14155238886`) or a production sender |
| **Test-mode sandbox** | Test credentials + magic numbers (`+15005550006` sender, any real-looking `to`) — no charge, no real delivery |
| **Messaging Service scoping** | Use `messagingServiceSid` instead of `from` for multi-number pools with geomatch and opt-out built in |
| **Tiered model routing** | Cheap (Haiku-class) for extraction/verify; Frontier (Sonnet/Opus) gated behind `TWILIO_TEST_MODE=false` |
| **MCP default-deny** | `.harness/mcp-policy.json` grants exactly six tools; all others denied; every call audited to `.harness/audit.jsonl` |
| **Verification gate** | Verifier agent reads back `messages.fetch(sid)` or `calls.fetch(sid)` and asserts status before reporting done |
| **All hosts** | `--host all` emits config for every supported host adapter |

---

## Quickstart

```bash
npx @metaharness/example-twilio@latest my-bot
cd my-bot
npm install
npm run doctor
```

`npm run doctor` checks that the required env vars are set and that the `twilio` SDK can be imported. It does not make any API calls.

To scaffold for a specific host:

```bash
npx @metaharness/example-twilio@latest my-bot --host codex
npx @metaharness/example-twilio@latest my-bot --host github-actions
npx @metaharness/example-twilio@latest my-bot --host all
```

---

## Configuration

### Environment variables

Set these before running the harness. Never commit them to source control.

| Variable | Required | Description | Where to get it |
|---|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Account SID (`AC…`) — use your **Test Account SID** for sandbox | [Twilio Console > API keys & tokens > Test credentials](https://console.twilio.com/) |
| `TWILIO_AUTH_TOKEN` | Yes | Auth Token — use your **Test Auth Token** for sandbox | Same page as above |
| `TWILIO_MESSAGING_SERVICE_SID` | Recommended | Messaging Service SID (`MG…`); preferred over a direct number | [Twilio Console > Messaging > Services](https://console.twilio.com/us1/develop/sms/services) |
| `TWILIO_FROM_NUMBER` | Alt | A direct Twilio phone number in E.164 (e.g. `+15005550006` for test mode) | [Twilio Console > Phone Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/active) |
| `TWILIO_WHATSAPP_FROM` | Optional | WhatsApp sender in `whatsapp:+<E.164>` format | Defaults to sandbox `whatsapp:+14155238886` |
| `TWILIO_TEST_MODE` | No | `true` (default) = test credentials + magic numbers; `false` = live sends require `--allow-live` | Set in your shell or `.env` (gitignored) |

### Using sandbox / test mode (default)

1. In the [Twilio Console](https://console.twilio.com/), go to **Account > API keys & tokens** and scroll to **Test credentials**.
2. Copy your **Test Account SID** and **Test Auth Token**.
3. Set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` to these test values.
4. Leave `TWILIO_TEST_MODE=true` (the default).

In this mode the executor agent automatically uses the magic number `+15005550006` as the sender (valid, passes validation) and the message is accepted by Twilio but never delivered to a real device. Your account is not charged.

**Magic number reference (test mode):**

| Number | Role | Behavior |
|---|---|---|
| `+15005550006` | `from` | Valid sender — passes validation |
| `+15005550001` | `from` or `to` | Invalid number error |
| `+15005550007` | `from` | Not owned / not SMS-capable |
| `+15005550008` | `from` | Queue full |
| `+15005550002` | `to` | Cannot route |
| `+15005550003` | `to` | Lacks international permissions |
| `+15005550004` | `to` | Blocked |
| `+15005550009` | `to` | Cannot receive SMS |

### Enabling live sends (opt-in)

Set `TWILIO_TEST_MODE=false` and pass `--allow-live` when running the harness. This escalates the executor to the frontier model tier and surfaces a confirmation prompt before any `client.messages.create()` or `client.calls.create()` call is issued with live credentials.

```bash
TWILIO_TEST_MODE=false node harness.mjs --allow-live
```

---

## Usage

### Slash command: `/sms`

Drives the planner → executor → verifier pipeline for a single outbound SMS or WhatsApp message.

```
/sms to=+15555550100 body="Your verification code is 4821"
/sms to=+15555550100 body="Hello from the agent" channel=whatsapp
/sms to=+15005550004 body="Test blocked-number path"
```

Parameters:

| Param | Default | Description |
|---|---|---|
| `to` | (required) | Destination in E.164 format |
| `body` | (required) | Message text |
| `channel` | `sms` | `sms` or `whatsapp` |
| `from` | env `TWILIO_FROM_NUMBER` | Override sender (ignored if `TWILIO_MESSAGING_SERVICE_SID` is set) |

### Representative natural-language prompts

Once the harness is running in your host:

```
Send a confirmation SMS to +15555550100 saying their order #7842 has shipped.
```

```
Call +15555550100 and say "Your appointment is confirmed for tomorrow at 9 AM."
```

```
Send a WhatsApp message to +15555550100: "Your package is out for delivery."
```

```
Test the blocked-number error path using magic number +15005550004.
```

In all cases the verifier agent reads back the returned `sid` and confirms the status before reporting success to the user.

---

## Safety

- **Secrets via environment only.** No credentials are written into any scaffolded file. The scaffold emits a `.env.example` with placeholder values and a `.gitignore` entry for `.env`.
- **Test mode by default.** `TWILIO_TEST_MODE=true` is the default. No real messages are sent; no account is charged; magic phone numbers simulate error paths without touching real devices.
- **Live-send double-gate.** Two conditions must both be true before a live send executes: `TWILIO_TEST_MODE=false` AND `--allow-live` CLI flag. The executor agent cannot bypass this gate.
- **Frontier model for live mutations.** Any live send escalates to the frontier model tier (ADR-026), ensuring a more capable model reviews the request before it leaves the system.
- **MCP default-deny.** Only six tools are granted in `.harness/mcp-policy.json`. Every tool call is logged to `.harness/audit.jsonl`.
- **No marketing scaffolding.** The scaffold generates transactional message patterns only. Bulk-send loops, subscriber list management, and opt-in collection are explicitly not included. Operators are responsible for TCPA compliance, carrier compliance, and Twilio's Acceptable Use Policy.
- **WhatsApp Sandbox limitations.** The sandbox (`whatsapp:+14155238886`) requires each end user to opt in by sending `join <code>` to the sandbox number. The scaffold cannot automate this step. Do not use the sandbox for production traffic.

---

## How it works

### Agent pipeline

```
User prompt / /sms command
        |
   [ planner ]  ← Tier 2 (cheap model)
   Parses intent; extracts to/body/channel/from;
   validates E.164; substitutes magic numbers in test mode
        |
   [ executor ] ← Tier 2 in test mode / Tier 3 (frontier) in live mode
   Calls client.messages.create() or client.calls.create()
   via the twilio SDK; captures returned sid
        |
   [ verifier ] ← Tier 2 (cheap model)
   Calls client.messages.fetch(sid) or client.calls.fetch(sid)
   Asserts status in { queued, sent, delivered }
   Reports pass/fail to user
```

### Routing tiers (ADR-026)

| Tier | Model class | Used for |
|---|---|---|
| 1 — Booster | WASM / no-LLM | Magic number substitution, E.164 validation, TwiML XML formatting |
| 2 — Cheap | Haiku-class | Planner extraction, verifier status check, error triage |
| 3 — Frontier | Sonnet/Opus | Live-mode executor, complex TwiML generation, ambiguity resolution |

### MCP policy — granted tools

The scaffolded `.harness/mcp-policy.json` grants exactly these tools (all others denied by default):

| Tool | Purpose |
|---|---|
| `twilio_messages_create` | Send SMS or WhatsApp message |
| `twilio_messages_fetch` | Read back message status (verifier) |
| `twilio_calls_create` | Initiate outbound voice call |
| `twilio_calls_fetch` | Read back call status (verifier) |
| `twilio_lookups_v2` | Validate and format E.164 phone numbers |
| `fs_read` | Read scaffold config and TwiML templates |

Every invocation of a granted tool appends one JSON line to `.harness/audit.jsonl` containing the tool name, timestamp, and (redacted) parameters.

### Host wiring

The scaffold delegates to the `metaharness` CLI and the relevant `@metaharness/host-<id>` adapter. Use `--host all` to emit configuration for every supported host simultaneously. Supported hosts: `claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`.

---

## Links

- [Twilio Node.js SDK (`twilio` on npm)](https://www.npmjs.com/package/twilio)
- [twilio-node GitHub repository](https://github.com/twilio/twilio-node)
- [Twilio Test Credentials and Magic Numbers](https://www.twilio.com/docs/iam/test-credentials)
- [Twilio Messaging Services](https://www.twilio.com/docs/messaging/services)
- [Twilio WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox)
- [Twilio Programmable Voice API](https://www.twilio.com/docs/voice/api)
- [Send SMS with Messaging Service (Node.js)](https://www.twilio.com/docs/messaging/tutorials/send-messages-with-messaging-services)
- [ADR-058: example-twilio design record](https://github.com/ruvnet/agent-harness-generator/tree/main/docs/adrs/ADR-058-example-twilio.md)
- [ADR-051: Third-party SDK showcase examples program](https://github.com/ruvnet/agent-harness-generator/tree/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
