# ADR-055: example-stripe — Stripe SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Stripe is the dominant payments infrastructure for SaaS products, marketplaces, and subscription businesses. An agent harness that cannot safely drive Stripe covers none of the workflows most frequently asked about: creating or cancelling a subscription, issuing a refund, responding to a webhook event, or querying billing status. These are exactly the operations developers want to automate with an AI agent — but they are also the operations where a mistake means real money moves or a real customer is affected.

The Stripe Node.js SDK (`stripe`, currently v22.x on npm) is the canonical server-side library for the Stripe API. It ships as an ES-module-first package, supports TypeScript out of the box, and provides built-in idempotency-key wiring, automatic network retries, and raw-body webhook signature verification. Stripe's native test mode — enabled simply by using an `sk_test_` prefixed secret key — makes it possible to exercise every billing and payment API call without ever touching a real card network or real funds.

Stripe falls into the "regulated payments" category: its APIs can charge cards, move money, and trigger financial obligations. This makes safety posture non-negotiable. The example must default to test mode, gate every mutating operation behind an explicit flag, and carry a prominent not-for-production disclaimer.

Stripe also offers an official MCP server at `https://mcp.stripe.com` and an agent toolkit for agentic billing workflows, making it directly relevant to the metaharness MCP default-deny and tool-grant model.

## Decision

### Chosen SDK

**Package**: `stripe` (npm, latest stable: v22.2.1 as of 2026-06-17).
**Import style** (ES module, as required by `"type": "module"`):

```js
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
```

The `stripe` package is the only official Stripe server-side SDK for Node.js. There is no alternative that covers subscriptions, refunds, webhook verification, and idempotency in a single maintained package. The browser-side `@stripe/stripe-js` package is explicitly out of scope.

### Headline capability

**Billing / subscription / refund operations in test mode by default, with idempotency keys and webhook signature verification.**

Concretely, the example showcases three agent-driven workflows:

1. **Subscription lifecycle** — create a customer, attach a price/plan, create a subscription, list active subscriptions, and cancel a subscription. Uses `stripe.customers.create`, `stripe.subscriptions.create`, `stripe.subscriptions.cancel`.
2. **Refund issuance** — look up a completed payment intent and issue a full or partial refund. Uses `stripe.refunds.create` with an idempotency key to prevent duplicate refunds on retry.
3. **Webhook event handling** — verify incoming Stripe webhook payloads via `stripe.webhooks.constructEvent`, route `customer.subscription.deleted` and `invoice.payment_failed` events, and emit a structured response.

All three workflows operate against Stripe's test environment by default (`sk_test_` keys, test card tokens, no real funds). The `--live` opt-in flag is required to switch to live mode; the scaffold code documents this prominently and refuses to emit live-mode configuration without the flag.

### Agent / skill design

| Agent | Tier | Responsibility |
|---|---|---|
| `billing-planner` | Frontier (Sonnet/Opus) | Parses natural-language billing intent, decides which Stripe API calls are needed, checks for edge cases (already cancelled, already refunded) |
| `billing-executor` | Haiku | Executes the resolved Stripe API calls with idempotency keys; records each call's result |
| `billing-verifier` | Haiku | Re-reads the Stripe object after mutation (subscription retrieve, refund retrieve) to confirm the server state matches the intended outcome; fails the verification gate if not |

Slash command: **`/stripe-billing`** — accepts a natural-language billing request (e.g. "cancel the subscription for customer cus_xxx and issue a prorated refund") and drives the planner → executor → verifier pipeline.

### Routing tiers

Following ADR-026:

- **Tier 1 (WASM booster)**: not applicable — Stripe API calls cannot be performed without network I/O.
- **Tier 2 (Haiku, ~$0.0002/call)**: `billing-executor` for structured API calls with a resolved plan; `billing-verifier` for read-back confirmation; webhook event routing where the event type is already parsed.
- **Tier 3 (Sonnet/Opus, $0.003–$0.015/call)**: `billing-planner` for natural-language intent parsing, disambiguation, edge-case detection, and plan generation. Any refund or cancellation that involves ambiguity (partial refund amount, proration policy, disputed charge) routes to Tier 3.

The routing decision is made by the planner based on a complexity score: operations with a fully-resolved plan and no ambiguity drop to Tier 2 for execution; the planner itself always runs at Tier 3.

### MCP policy

`.harness/mcp-policy.json` — default-deny per ADR-022. Granted tools (minimum necessary):

```json
{
  "version": "1",
  "default": "deny",
  "audit_log": ".harness/mcp-audit.jsonl",
  "grants": [
    {
      "tool": "stripe_customers_create",
      "reason": "billing-executor: provision customer record in test mode"
    },
    {
      "tool": "stripe_customers_retrieve",
      "reason": "billing-verifier: read-back customer after creation"
    },
    {
      "tool": "stripe_subscriptions_create",
      "reason": "billing-executor: create subscription in test mode"
    },
    {
      "tool": "stripe_subscriptions_retrieve",
      "reason": "billing-verifier: confirm subscription state after mutation"
    },
    {
      "tool": "stripe_subscriptions_cancel",
      "reason": "billing-executor: cancel subscription (mutation, opt-in required)"
    },
    {
      "tool": "stripe_refunds_create",
      "reason": "billing-executor: issue refund with idempotency key (mutation, opt-in required)"
    },
    {
      "tool": "stripe_refunds_retrieve",
      "reason": "billing-verifier: confirm refund status after creation"
    },
    {
      "tool": "stripe_payment_intents_retrieve",
      "reason": "billing-planner: look up payment intent before issuing refund"
    },
    {
      "tool": "stripe_webhooks_construct_event",
      "reason": "webhook handler: verify Stripe signature before processing event"
    }
  ]
}
```

All tools not listed above are denied. Every grant is recorded in `.harness/mcp-audit.jsonl` with timestamp, tool name, agent identity, and call result.

### Auth model

| Credential | Env var | Where to obtain |
|---|---|---|
| Secret API key | `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys |
| Publishable key (client-side, optional) | `STRIPE_PUBLISHABLE_KEY` | Same page, starts with `pk_test_` |
| Webhook signing secret | `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → Signing secret, starts with `whsec_` |

Test-mode keys begin with `sk_test_` and `pk_test_`. The SDK automatically operates in test mode when these prefixes are present — no additional configuration is needed. The example's scaffold never writes any key value to disk; it only writes references to `process.env.*` variables.

### Safety gates

1. **Test mode by default**: the scaffold generates a harness that validates `STRIPE_SECRET_KEY` starts with `sk_test_` at startup and aborts with a clear error if a live key (`sk_live_`) is detected and `--live` was not passed.
2. **Mutation opt-in**: the `/stripe-billing` command defaults to a dry-run simulation mode that describes the intended API calls without executing them. Passing `--execute` triggers the executor agent. This applies to all three mutating operations: subscription creation, subscription cancellation, and refund issuance.
3. **Idempotency keys**: all POST calls in the executor are wrapped with a V4 UUID idempotency key generated per-intent, preventing duplicate charges or refunds on retry.

```js
const idempotencyKey = crypto.randomUUID();
const refund = await stripe.refunds.create(
  { payment_intent: piId, amount: amountCents },
  { idempotencyKey }
);
```

4. **Webhook signature verification**: the webhook handler calls `stripe.webhooks.constructEvent` with the raw body and the `stripe-signature` header before any event processing. Events that fail verification are rejected with a 400 and logged.
5. **No live-mode scaffolding by default**: the `--live` flag must be explicitly passed to `npx @metaharness/example-stripe` for the scaffold to generate live-key references. The README documents this and carries the not-for-production disclaimer below.

### Not-for-production disclaimer

> This example is illustrative and educational. It is not PCI-DSS compliant out of the box, not a certified payment integration, and must not be used to process real payments without a full security and compliance review. Run only in Stripe test mode unless you understand the financial and compliance implications of live-mode API calls.

## Consequences

### Positive

- Gives developers a one-command starting point for agent-driven Stripe billing that is safe by default.
- Demonstrates all five metaharness capability pillars (tiered routing, MCP default-deny, slash command, multi-agent, verification gate) on a platform that nearly every SaaS developer encounters.
- Idempotency key wiring and webhook signature verification are production-grade patterns that survive past the example.
- Test mode is native to Stripe's API design; no mocking or stubbing is required — real API calls against a real Stripe test environment exercise the full code path.

### Limitations

- The example does not cover Stripe Connect (marketplace payouts), Stripe Radar (fraud rules), Stripe Tax, or Stripe Terminal — these are significant Stripe product lines but out of scope for a showcase.
- Webhook delivery in local development requires the Stripe CLI (`stripe listen --forward-to localhost:3000/webhook`) or a tunnel (ngrok); the scaffold documents this but cannot automate it portably across all hosts.
- The verification gate (read-back after mutation) catches server-state mismatches but cannot detect all failure modes, e.g. a refund accepted by Stripe but later reversed by the card network.
- Live-mode operations incur real financial consequences. The example's `--live` guard is advisory, not a hard cryptographic barrier.
- This example is illustrative and not certified for PCI-DSS compliance. Real payment integrations require a dedicated security and compliance review.
