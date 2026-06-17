# ADR-058: example-twilio — Twilio SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Twilio is the dominant programmable-communications platform: SMS, voice calls, WhatsApp Business messaging, and channel-agnostic Messaging Services are routine requirements for agents that notify users, collect confirmations, or drive customer-facing workflows. The `twilio` npm package (currently v5.x, written in TypeScript, published as `twilio` on the npm registry) is the canonical Node.js helper library; it is the most-downloaded Twilio client across all languages, with millions of weekly downloads, and is officially maintained by Twilio.

An agent harness wired to Twilio can realistically drive three headline workflows:

1. **SMS dispatch and receipt** — send transactional or conversational SMS via a direct Twilio phone number or a Messaging Service pool, then verify delivery status by reading the message resource back.
2. **Outbound voice calls with TwiML** — initiate a call to a real or test number and supply TwiML instructions (say, gather, record) as inline XML or a URL; status callbacks report call progress.
3. **WhatsApp messaging** — send template or session messages using the `whatsapp:+<E.164>` channel prefix; the WhatsApp Sandbox (`whatsapp:+14155238886`) provides a zero-cost test environment.

Twilio provides first-class test infrastructure — **test credentials** (a separate Account SID / Auth Token pair available in the Twilio Console under "API keys & tokens > Test credentials") and **magic phone numbers** (`+15005550006` for a valid sender, `+15005550001`–`+15005550009` for specific error scenarios). When authenticated with test credentials, Twilio never charges the account, never mutates account state, and never connects to real phone numbers. This makes it an ideal showcase for MetaHarness's dry-run-by-default safety posture.

Twilio Messaging Services (SID prefix `MG`) are a higher-level abstraction: they hold a pool of senders, apply sticky-sender logic, handle opt-out, and support country-code geomatch. An agent using a Messaging Service sends with `messagingServiceSid` rather than `from`, enabling scale-out without hardcoding a single number.

Twilio is not a regulated-domain platform in the health/financial/weapons sense, but SMS and WhatsApp are regulated communication channels: TCPA in the US and equivalent laws elsewhere require opt-in consent before sending marketing messages. The example scaffolds only transactional patterns (notification, confirmation, agent-driven alerts) and does not scaffold marketing flows.

## Decision

### Chosen SDK

**`twilio`** (npm) — the official Twilio Node.js helper library. No alternative is needed: `twilio` is the single canonical package for all Twilio REST APIs (Messages, Calls, Messaging Services, WhatsApp). It is TypeScript-native since v4, ships dual CJS/ESM builds, and supports Node.js 20, 22, and 24 LTS. Install: `npm install twilio`.

Import style (ESM, `"type": "module"`):
```js
import twilio from 'twilio';
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
```

Import style (CJS):
```js
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
```

### Headline capability

SMS/voice/WhatsApp with Twilio's **test credentials + magic phone numbers** as the default sandbox, and **Messaging Service scoping** (`messagingServiceSid`) as the canonical send path for multi-number pools.

### Agent and skill design

The scaffold generates three specialized agents and one slash command:

| Agent | Role | Model tier |
|---|---|---|
| `planner` | Parses the user's intent (who to message, what channel, what content); extracts structured params from natural language; routes to executor | Cheap (Haiku-class) |
| `executor` | Calls the Twilio REST API via the `twilio` SDK; sends SMS, initiates voice calls, or dispatches WhatsApp messages; captures the returned `sid` | Cheap (Haiku-class) for test mode; Frontier for live mutation |
| `verifier` | Reads the message/call resource back by `sid` and checks `status` (`queued`, `sent`, `delivered`, `failed`); reports pass/fail to the user | Cheap (Haiku-class) |

Slash command: **`/sms`** — drives the planner → executor → verifier pipeline for a single SMS or WhatsApp outbound message. Example invocation: `/sms to=+15555550100 body="Your code is 4821"`. In test mode the executor substitutes the `to` number with `+15005550006` and uses test credentials; the verifier reads back the returned `sid` and confirms `status === "queued"`.

### Routing tiers (ADR-026)

| Tier | Handler | When used |
|---|---|---|
| 1 — Booster | WASM / no-LLM | Structural transforms: substitute test magic numbers, format TwiML XML, validate E.164 phone numbers |
| 2 — Cheap | Haiku-class | Fan-out extraction (parse free-text into `to`/`body`/`channel`), verifier status check, error triage |
| 3 — Frontier | Sonnet/Opus | Any live-mode send decision (TWILIO_TEST_MODE=false); TwiML generation for complex voice flows; ambiguity resolution |

The planner always runs at Tier 2. The executor escalates to Tier 3 only when `TWILIO_TEST_MODE` is `false` (live send), enforcing a human-cost checkpoint before any real message is dispatched.

### MCP policy — granted tools (`.harness/mcp-policy.json`)

Default-deny (ADR-022). The policy grants exactly:

```json
{
  "version": "1",
  "default": "deny",
  "audit": true,
  "grants": [
    { "tool": "twilio_messages_create",   "reason": "send SMS / WhatsApp via REST" },
    { "tool": "twilio_messages_fetch",    "reason": "read-back message status (verifier)" },
    { "tool": "twilio_calls_create",      "reason": "initiate outbound voice call" },
    { "tool": "twilio_calls_fetch",       "reason": "read-back call status (verifier)" },
    { "tool": "twilio_lookups_v2",        "reason": "validate E.164 phone number format" },
    { "tool": "fs_read",                  "reason": "read scaffold config and TwiML templates" }
  ]
}
```

All other MCP tools (file write, shell exec, network fetch to non-Twilio hosts, memory mutation) are denied by default. The audit log writes one JSON line per tool call to `.harness/audit.jsonl`.

### Auth model

| Env var | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Account SID (starts with `AC`) — or Test Account SID for sandbox |
| `TWILIO_AUTH_TOKEN` | Yes | Auth Token — or Test Auth Token for sandbox |
| `TWILIO_MESSAGING_SERVICE_SID` | Recommended | Messaging Service SID (starts with `MG`); used instead of `from` for pooled sending |
| `TWILIO_FROM_NUMBER` | Alt to above | A direct Twilio phone number in E.164 format; used when no Messaging Service is configured |
| `TWILIO_WHATSAPP_FROM` | Optional | WhatsApp sender in `whatsapp:+<E.164>` format; defaults to sandbox `whatsapp:+14155238886` |
| `TWILIO_TEST_MODE` | No | Set to `false` to allow live sends; defaults to `true` (test credentials expected) |

The `twilio` SDK also reads `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` automatically from the environment when no arguments are passed to the constructor. The scaffold does not write these values into any scaffolded file.

### Safety gates

1. **Default test mode**: `TWILIO_TEST_MODE` defaults to `true`. In this mode the executor agent replaces the target `to` number with the magic number `+15005550006` (valid, no delivery) and expects the caller to supply test credentials. No real message is sent; no account is charged.
2. **Test credential enforcement**: when `TWILIO_TEST_MODE=true` the planner agent validates that `TWILIO_ACCOUNT_SID` begins with `AC` and emits a warning if it looks like a live SID (live SIDs also begin with `AC` but the user is warned to double-check they are using test credentials from the Console).
3. **Live-send opt-in**: setting `TWILIO_TEST_MODE=false` escalates the executor to Tier 3 (frontier model), surfaces a confirmation prompt, and requires an explicit `--allow-live` flag at the CLI level before the `client.messages.create()` call is issued. This gate cannot be bypassed by the agent itself.
4. **WhatsApp sandbox default**: the WhatsApp sender defaults to `whatsapp:+14155238886` (Twilio's shared sandbox number). To use a production WhatsApp sender the user must set `TWILIO_WHATSAPP_FROM` and set `TWILIO_TEST_MODE=false`.
5. **No marketing scaffolding**: the example scaffolds transactional message patterns only. It does not generate opt-in collection flows, subscriber list management, or bulk-send loops, as those require TCPA-compliant consent infrastructure beyond the scope of a scaffold.

## Consequences

### Positive

- Provides a one-command proof that a MetaHarness-generated harness can drive real-world SMS, voice, and WhatsApp workflows across all nine supported hosts.
- Test credentials + magic numbers mean the example is safe to run immediately after scaffolding without any spending risk or real message delivery.
- Messaging Service scoping (`messagingServiceSid`) demonstrates the more production-appropriate send path, not just a single `from` number.
- The three-agent pipeline (planner / executor / verifier) cleanly illustrates ADR-026 tiered routing and ADR-050 verification-gated output in a concrete, non-abstract context.
- The MCP policy grants exactly six tools, making it an easy-to-audit showcase of ADR-022 default-deny.

### Limitations

- Test credentials cannot be used with the Twilio CLI (`twilio login`); they work only with the REST API / SDK.
- The WhatsApp Sandbox requires each end user to manually opt in by sending `join <code>` to the sandbox number; the scaffold cannot automate this join step.
- Voice call verification (read-back status) may lag because call status transitions asynchronously; the verifier polls up to a configurable timeout rather than guaranteeing a synchronous `completed` status.
- Messaging Services must be pre-created in the Twilio Console; the scaffold cannot create a Messaging Service programmatically in test mode.
- This example does not scaffold inbound webhook handling (receiving SMS/calls) — that requires a publicly reachable URL (e.g., ngrok) which is environment-dependent.
- **Not certified for TCPA compliance.** SMS and WhatsApp messaging is subject to carrier filtering, opt-in consent laws (TCPA in the US, GDPR/ePrivacy in the EU, and equivalents elsewhere), and Twilio's own Acceptable Use Policy. This scaffold is illustrative. Operators must obtain proper consent, configure opt-out handling, and review applicable regulations before sending messages to real phone numbers.
