# @metaharness/example-stripe

> Agent harness scaffold pre-wired to the Stripe billing API — subscriptions, refunds, and webhook handling in TEST MODE by default.

> **Illustrative output**: This package scaffolds example agent harness code for educational and prototyping purposes. The generated harness exercises the Stripe test environment only by default. It is **not** a production-ready payment integration, is **not** PCI-DSS certified, and **must not** be used to process real payments without a full security and compliance review.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-stripe?label=npm&color=6772e5)](https://www.npmjs.com/package/@metaharness/example-stripe)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-stripe?color=6772e5)](https://www.npmjs.com/package/@metaharness/example-stripe)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Built with MetaHarness](https://img.shields.io/badge/built%20with-metaharness-8b5cf6)](https://github.com/ruvnet/agent-harness-generator)

---

## What it is

`@metaharness/example-stripe` is a MetaHarness scaffold package that generates a complete AI agent harness pre-wired to the [Stripe Node.js SDK](https://github.com/stripe/stripe-node) (`stripe` v22.x). Running it with `npx` produces a ready-to-run project directory containing three specialized agents, a `/stripe-billing` slash command, a scoped MCP policy, and all the plumbing to drive Stripe billing operations from natural-language prompts.

**What it is NOT**: a PCI-DSS compliant payment integration, a certified financial application, or a replacement for a proper Stripe implementation review. It is an educational scaffold that shows how metaharness patterns (tiered model routing, MCP default-deny, verification-gated output) combine with a real third-party SDK.

---

## Features

| Capability | What the harness does |
|---|---|
| **Subscription lifecycle** | Create customers, attach prices, create/cancel subscriptions via `stripe.subscriptions.*` |
| **Refund issuance** | Look up a PaymentIntent and issue a full or partial refund via `stripe.refunds.create` with a per-intent idempotency key |
| **Webhook event handling** | Verify Stripe webhook signatures with `stripe.webhooks.constructEvent`; route `customer.subscription.deleted` and `invoice.payment_failed` events |
| **Idempotency keys** | Every mutating POST call is wrapped with a V4 UUID idempotency key — safe to retry on network failure |
| **Tiered model routing** | `billing-planner` (Frontier/Sonnet) resolves intent; `billing-executor` + `billing-verifier` (Haiku) execute and confirm at low cost |
| **MCP default-deny** | `.harness/mcp-policy.json` grants exactly 9 Stripe tools; everything else is denied and audited |
| **Verification gate** | After every mutation, `billing-verifier` reads back the Stripe object to confirm server state before reporting done |
| **Multi-host scaffolding** | `--host <id>` emits config for Claude Code, Codex, Copilot, GitHub Actions, Hermes, OpenClaw, OpenCode, Pi-Dev, or RVM; `--host all` emits every host |

---

## Quickstart

```bash
npx @metaharness/example-stripe@latest my-stripe-bot
cd my-stripe-bot
npm install
npm run doctor
```

`npm run doctor` checks that `STRIPE_SECRET_KEY` is set and starts with `sk_test_`, that `STRIPE_WEBHOOK_SECRET` is present, and that the `stripe` SDK is importable.

To scaffold for a specific host:

```bash
npx @metaharness/example-stripe@latest my-stripe-bot --host github-actions
```

To scaffold for every host at once:

```bash
npx @metaharness/example-stripe@latest my-stripe-bot --host all
```

---

## Configuration

### Environment variables

| Variable | Required | Description | Where to get it |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Server-side secret key. **Must start with `sk_test_`** in the default test-mode harness. | [Stripe Dashboard](https://dashboard.stripe.com/test/apikeys) → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Yes (for webhook handler) | Signing secret for webhook signature verification. Starts with `whsec_`. | [Stripe Dashboard](https://dashboard.stripe.com/test/webhooks) → Webhooks → your endpoint → Signing secret |
| `STRIPE_PUBLISHABLE_KEY` | No | Client-side key (`pk_test_`). Only needed if the scaffold emits a front-end component. | Same API keys page |

**Never put key values in source files.** Store them in `.env` (gitignored) or your host's secrets manager. The scaffolded code references `process.env.*` only.

### Test mode (default)

Stripe's test environment is activated simply by using test-mode keys (`sk_test_`, `pk_test_`). No separate endpoint or flag is needed — the Stripe API server routes all calls made with test keys to an isolated, non-financial environment. Test transactions do not move real money, do not go through card networks, and do not appear in your live Stripe dashboard.

The generated harness validates at startup that `STRIPE_SECRET_KEY` starts with `sk_test_` and aborts with a clear error if a live key is detected without an explicit `--live` flag.

**To get test keys**: sign in to [dashboard.stripe.com](https://dashboard.stripe.com), ensure the "Test mode" toggle is on (top-right), and copy the secret key from Developers → API keys.

**Test card numbers**: use `4242424242424242` (Visa, always succeeds), `4000000000000002` (always declined), or any of Stripe's [test card catalog](https://docs.stripe.com/testing).

### Webhook local development

For local webhook testing, use the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```bash
stripe login
stripe listen --forward-to localhost:3000/webhook
```

The CLI prints a webhook signing secret (`whsec_...`) — set that as `STRIPE_WEBHOOK_SECRET` for local runs. For hosted environments, create an endpoint in the Stripe Dashboard and copy the signing secret from there.

### Live mode (explicit opt-in)

To scaffold a harness that references live keys, pass `--live` to the scaffolder:

```bash
npx @metaharness/example-stripe@latest my-stripe-bot --live
```

This emits a warning, documents the compliance implications in the generated README, and requires `STRIPE_SECRET_KEY` to start with `sk_live_`. **Do not use live mode without a proper security and compliance review.**

---

## Usage

### Slash command

```
/stripe-billing <natural-language billing request>
```

By default this runs in **dry-run / simulation mode** — the planner resolves the intent and describes the Stripe API calls it would make, but nothing is executed.

To execute the plan:

```
/stripe-billing --execute <request>
```

### Example prompts

```
/stripe-billing Create a new customer for alice@example.com and start them on the Pro monthly plan (price_xxx)
```

```
/stripe-billing Cancel the subscription sub_xxx immediately and issue a full refund on the last invoice
```

```
/stripe-billing --execute Issue a $15 partial refund on payment intent pi_xxx for a duplicate charge
```

```
/stripe-billing List all active subscriptions for customer cus_xxx
```

The planner agent parses each request, the executor agent calls the Stripe API with idempotency keys, and the verifier agent reads back the resulting Stripe objects before reporting done.

---

## Safety

| Gate | Behavior |
|---|---|
| Test mode enforcement | Harness aborts at startup if `STRIPE_SECRET_KEY` does not start with `sk_test_` (unless `--live` was passed to the scaffolder) |
| Dry-run default | `/stripe-billing` simulates without calling Stripe unless `--execute` is passed |
| Idempotency keys | All POST mutations use `crypto.randomUUID()` per-intent — safe to retry |
| Webhook signature | `stripe.webhooks.constructEvent` verifies HMAC-SHA256 + 5-minute timestamp tolerance before any event processing; rejects unverified payloads with HTTP 400 |
| MCP default-deny | Only 9 specific Stripe tools are granted; all others are denied and logged to `.harness/mcp-audit.jsonl` |
| Verification gate | `billing-verifier` reads back every mutated Stripe object before the harness reports success |
| No credentials in files | Scaffold never writes key values to disk; only `process.env.*` references are emitted |

> **Payments disclaimer**: This example is illustrative and educational. It is **not** PCI-DSS compliant out of the box and **not** a certified payment integration. It must not be used to process real payments without a full security and compliance review. Run only against Stripe test-mode keys unless you fully understand the financial and legal implications of live-mode API calls.

---

## How it works

### Agent pipeline

```
User prompt
    |
    v
billing-planner (Frontier tier — Sonnet/Opus)
  - Parses natural-language billing intent
  - Resolves ambiguity, checks for edge cases
    (already cancelled? already refunded?)
  - Emits a structured plan: list of Stripe API calls + params
    |
    v
billing-executor (Haiku tier — cheap, fast)
  - Executes the plan against the Stripe test API
  - Attaches a V4 UUID idempotency key to every POST
  - Records each call result
    |
    v
billing-verifier (Haiku tier)
  - Reads back each mutated Stripe object
  - Compares server state to intended outcome
  - Fails the verification gate if they diverge
    |
    v
Structured result returned to user
```

### Routing tiers (ADR-026)

| Tier | Model | Used for |
|---|---|---|
| 2 — cheap | Haiku (~$0.0002/call) | `billing-executor`: structured API calls with a resolved plan; `billing-verifier`: read-back confirmation; webhook event routing |
| 3 — frontier | Sonnet/Opus ($0.003–$0.015/call) | `billing-planner`: natural-language parsing, ambiguity resolution, refund/proration edge cases |

### MCP policy — granted tools

The `.harness/mcp-policy.json` file grants exactly these 9 tools (all others denied):

| Tool | Agent | Purpose |
|---|---|---|
| `stripe_customers_create` | executor | Create customer record (test mode) |
| `stripe_customers_retrieve` | verifier | Read-back after creation |
| `stripe_subscriptions_create` | executor | Start subscription |
| `stripe_subscriptions_retrieve` | verifier | Confirm subscription state |
| `stripe_subscriptions_cancel` | executor | Cancel subscription (mutation, `--execute` required) |
| `stripe_refunds_create` | executor | Issue refund with idempotency key (mutation, `--execute` required) |
| `stripe_refunds_retrieve` | verifier | Confirm refund status |
| `stripe_payment_intents_retrieve` | planner | Look up PaymentIntent before refunding |
| `stripe_webhooks_construct_event` | webhook handler | Verify Stripe signature |

Every tool call is written to `.harness/mcp-audit.jsonl` with timestamp, agent identity, tool name, and outcome.

---

## Links

- [Stripe Node.js SDK (`stripe` on npm)](https://github.com/stripe/stripe-node)
- [Stripe API reference](https://docs.stripe.com/api)
- [Stripe test mode documentation](https://docs.stripe.com/testing)
- [Stripe idempotency](https://docs.stripe.com/idempotency)
- [Stripe webhook signature verification](https://docs.stripe.com/webhooks)
- [Stripe sandboxes](https://docs.stripe.com/sandboxes)
- [Stripe agent billing workflows](https://docs.stripe.com/agents-billing-workflows)
- [ADR-055: example-stripe design rationale](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-055-example-stripe.md)
- [ADR-051: Third-party SDK showcase examples program](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
