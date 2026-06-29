# ADR-203 — Cognitum Fugu: a GCP-hosted, metered, tiered Completions API on MetaHarness

**Status:** Proposed (rev 2 — peer review addressed; ready for Approved)
**Date:** 2026-06-29
**Rev 2 note:** This revision addresses the peer review — Firestore counter
throughput (hot-spotting on single-doc transactional increments), stream-truncation
billing leakage, the auto-route scope-mismatch UX (silent downgrade), the pricing
formula, and the τ escalation-threshold design. The one remaining open integration
dependency is unchanged: the `accountId` field on cognitum-one/api `api_keys` (§6, §10).
**Related:** ADR-180 (GCP VM runner + Firestore results store), ADR-201 (cheap-model lift / cheap-vs-frontier), ADR-150 ($0 local inference), cognitum-one/api ADR-092 (api.cognitum.one gateway), AgentBBS ADR-0012 (emulator-first GCP)
**Grounding artifacts (read, cited — not invented):**
- `docs/research/SAKANA_FUGU_REVERSE_ENGINEERING.md` — what Fugu is and what we do / don't replicate.
- `docs/research/retort-placement/PLACEMENT.md` (+ `results-*.csv`, `placement-analysis-v4.json`) — the measured cost-vs-capability Pareto data that *justifies* tiering.
- `cognitum-one/api` repo (`docs/api-keys.md`, `docs/architecture.md`, `docs/security-review.md`, `docs/deployment.md`, `openapi/cognitum-api.yaml`) — the REAL `cog_…` API-key scheme this ADR integrates with.
- `AgentBBS/infra/agentbbs-gcp/` (`terraform/main.tf`, `README.md`, `docker-compose.emulators.yml`) — the validated Firestore + Pub/Sub + Cloud-Functions-gen2 metering shape, emulator-first.

---

## 0. Executive summary

We propose **Cognitum Fugu** — an OpenAI-compatible, **metered** `/v1/chat/completions`
(+ `/v1/completions`) endpoint served under the existing `api.cognitum.one` gateway,
authenticated with the **real `cog_…` API-key scheme** already in production, with
**three difficulty/SLA tiers** routed by **MetaHarness's bounded-ReAct + cost-aware
router**. It is the **honest, simpler analog of Sakana Fugu**: we replicate *tiered
orchestration over a swappable model pool*; we **do not** replicate Fugu's
CMA-ES/GRPO-*trained* coordinator (TRINITY + Conductor). Routing is heuristic
confidence/difficulty signalling, not a learned 0.6B head.

Tiering is **not marketing**: it is grounded in our own metered DoE
(`PLACEMENT.md`). The cheap tier is **genuinely frontier-class on everyday work**
(coverage **0.954** vs frontier's **0.958** at **~12× lower $/task**); the high tier
exists because the cheap-tier capability ceiling is **structural** (best cheap model
0.928 < 0.958 coverage; never dominates the frontier on hard tasks). We route by
*request difficulty / SLA*, charging cheap when cheap is sufficient and frontier only
when the gap is real.

---

## 1. Context / problem

### 1.1 Why a metered Completions API for Cognitum

`api.cognitum.one` (cognitum-one/api, ADR-092) is today a commerce/devices gateway:
catalog, payments, leads, Seed-device OTA, MCP SSE. It already has a production-grade
**API-key system** (`cog_…`, Firestore-backed, scoped, rate-limited, audited) and a
**Cloud Run gateway → Cloud Functions** routing layer. What it does *not* yet expose
is the asset that everything else in this org is built around: **LLM inference**.
Customers, the Cognitum dashboard, the Seed fleet, and third-party SDKs
(`cognitum-one/sdks`) all want a single, billable, OpenAI-drop-in completions endpoint
they can point an existing client at.

The requirement is therefore: **an OpenAI-compatible completions API, authed with the
keys we already issue, metered to the token, deployed on the GCP footprint we already
run, that gives customers a real cost/capability dial instead of a single take-it-or-
leave-it model.**

### 1.2 The Fugu-style multi-model value proposition

Per `SAKANA_FUGU_REVERSE_ENGINEERING.md` §1, Sakana Fugu (2026-06-22) is **not** a
SWE-bench solver — it is *a learned multi-model orchestrator that routes a query across
a swappable pool of frontier LLMs* (pool: Claude Opus 4.8, GPT-5.5, Gemini 3.1 Pro),
assigning **Thinker / Worker / Verifier** roles. Two research systems underpin it:

- **TRINITY** (arXiv:2512.04695): a ~0.6B coordinator evolved with **separable
  CMA-ES**, a ~10K-parameter routing head over hidden states.
- **Conductor** (arXiv:2512.04388): a **7B** model trained with **GRPO** that emits
  natural-language coordination topologies and can recursively self-call.

Fugu's per-query model selection is **proprietary** and the coordinator is *trained*.
The value proposition we want to capture is the orchestration outcome — *route each
request to the cheapest model that can serve it well, escalate only when needed* — **not**
the trained coordinator itself, which we have neither the labelled routing data nor the
need to reproduce on day one. §6 records the trained-coordinator path as a deferred
alternative.

---

## 2. Decision

1. Ship a new upstream behind the existing `api.cognitum.one` gateway:
   **`apicompletions`** — a **Cloud Run service** (not a Cloud Function: completions
   need long-lived **SSE streaming** and 60–300 s timeouts) exposing
   **`POST /v1/chat/completions`**, **`POST /v1/completions`**, and **`GET /v1/models`**,
   wire-compatible with the OpenAI API.
2. Use **MetaHarness as the routing/orchestration engine** behind the endpoint — its
   bounded-ReAct loop and cheap↔frontier router (the exact stack measured in
   `PLACEMENT.md`) — exposed in two modes: **non-agentic passthrough** (route → single
   model → stream) and **agentic** (bounded ReAct with tools, for the `*-agent` model
   aliases). The Fugu-style logic is **tier resolution + optional confidence-driven
   escalation**, heuristic not trained.
3. Offer **three tiers** — `low` / `mid` / `high` — each backed by a concrete model
   pool (§4), selectable explicitly (`cognitum-low|mid|high`) or automatically
   (`cognitum-auto`, the default).
4. **Authenticate with the real `cog_…` scheme** (cognitum-one/api), adding three
   permission scopes — `completions:low`, `completions:mid`, `completions:high` — to
   the existing `api_keys` model. No new auth system. Key validation is server-side
   only and identical to the production `apiCreatePayment` flow.
5. **Meter every request** to a Firestore `usage_ledger` and a Pub/Sub →
   gen2-aggregator rollup, reusing the **agentbbs-gcp** Firestore + Pub/Sub +
   Cloud-Functions pattern. Enforce **per-key, per-tier rate limits and quotas** with a
   **scatter-gather / append-only counter** (TTL'd `usage_ticks` subcollection +
   `COUNT()` aggregation, §5.3) — *not* single-document transactional increments, which
   hit Firestore's ~1 write/sec/document contention wall under a busy key. This still
   fixes the per-instance-limiter defect logged in cognitum-one/api
   `security-review.md §1` (global, not per-instance) without re-introducing a hot-spot.
6. **Emulator-first development** (`FIRESTORE_EMULATOR_HOST` / `PUBSUB_EMULATOR_HOST`)
   plus a **mock model provider**, so the whole system — including this design work —
   is **$0**. No paid model runs are required to build or test it.
7. Deploy to the existing GCP project **`cognitum-20260110`, region `us-central1`**, via
   a **reviewable Terraform** module extending the agentbbs-gcp shape. No blind apply.

---

## 3. Architecture

### 3.1 Request flow

```
1. Client     POST https://api.cognitum.one/v1/chat/completions
              X-API-Key: cog_3f7a8b9c…              (or Authorization: Bearer cog_…)
              { "model": "cognitum-auto", "messages": [...], "stream": true }
2. Cloudflare DNS-only (proxied=false) → request goes straight to Google.
3. Google FE  Terminates TLS (Google-managed cert), routes by host to Cloud Run.
4. apigateway Path /v1/chat/completions → forwards to apicompletions (Cloud Run).
5. apicompletions:
   a. AUTH      Read X-API-Key → SHA-256 → Firestore api_keys lookup by hash.
                Check active, expiresAt. (identical to apiCreatePayment, arch.md §Request flow)
   b. TIER      Resolve requested tier from model alias / X-Cognitum-Tier header.
                Enforce key holds completions:<tier> scope (or escalation ceiling).
   c. LIMIT     Firestore sliding-window counter per (key, tier). 429 on exceed.
                Idempotency-Key dedupe lookup (replay → cached response).
   d. ROUTE     MetaHarness router: intrinsic difficulty signal → starting tier →
                model from the tier pool. (auto mode only)
   e. INFER     Call provider (OpenRouter / direct) with the resolved model.
                Stream SSE chunks back to the client (OpenAI-compatible).
   f. ESCALATE  (auto + opt-in) verifier confidence < τ → re-answer at next tier (once).
   g. METER     On completion publish a usage event to Pub/Sub completions-usage;
                write usage_ledger doc; bump per-key/per-account counters.
6. Response   SSE stream (or single JSON if stream=false) flows back up unchanged;
              gateway only normalizes the error envelope {error, code, requestId}.
```

This is the **same topology** as the production payment path (cognitum-one/api
`architecture.md`, "Request flow" §5) — gateway forwards, the upstream owns auth +
business logic — extended with the route/infer/escalate/meter steps.

### 3.2 Model pool per tier (real models)

Pools are config (Firestore `tier_config/{tier}` doc, hot-reloadable), seeded from the
Fugu pool (Opus 4.8 / GPT-5.5 / Gemini 3.1 Pro) plus the cheap models our DoE measured
(`PLACEMENT.md` model mapping):

| Tier   | Primary models                                  | Role / when                                            |
|--------|-------------------------------------------------|--------------------------------------------------------|
| `low`  | `deepseek-v4-pro`, `glm-5.2`                     | Everyday work. Frontier-class coverage at ~12× lower cost (§5). |
| `mid`  | `gpt-5.5`, `gemini-3.1-pro`                      | Faster-frontier / balanced; long context, moderate reasoning.   |
| `high` | `claude-opus-4.8`, `gpt-5.5` (reasoning profile) | Hard tasks where the cheap-tier ceiling is structural (§5).     |

Each tier has an ordered **fallback chain** (the configurable model-fallback chain
landed in the recent CVE-bench runner work, commit `de512bd`) so a provider 5xx/timeout
fails over within the tier *without* silently changing the billed tier.

### 3.3 Fugu-style routing logic (honest analog)

**Auto mode (`cognitum-auto`, default).** MetaHarness computes an **intrinsic difficulty
signal** from the request alone — prompt length, presence of code/diffs, reasoning
markers, requested `max_tokens`, tool/function-calling presence — and maps it to a
starting tier. This is exactly the **task-difficulty-aware routing** validated in
`PLACEMENT.md §7` (intrinsic signal, ~33% escalation, killed all timeouts), applied at
*request* rather than *campaign* granularity.

**Confidence-driven escalation (opt-in).** If a `low`/`mid` answer's verifier
self-confidence falls below the internal threshold **τ**, the harness re-answers **once**
at the next tier (capped by the key's scopes and the request's `max_tier`). This maps
loosely to Fugu's **Verifier** role — but it is a heuristic check, not a learned head.
**τ is an internal, adaptive, MetaHarness-owned mechanism, never a public input** — its
design and the reasons it is *not* exposed as a raw float are in §6.5. Escalation is
**always billed transparently** at the tier actually used and surfaced in the response
(`x_cognitum.escalated`, `x_cognitum.resolved_tier`, optional `x_cognitum.routing_reason`).

**Scope-mismatch handling (auto mode).** When the request's intrinsic difficulty needs a
tier the key does **not** hold (e.g. difficulty → `high`, key holds only
`completions:low`), behaviour is governed by the `fallback_policy` request field —
`fail_fast` (default: **403**, no silent downgrade) or `best_effort` (run at the highest
held tier and flag `x_cognitum.cap_degraded: true`). Full semantics in §6, item 2.

**Explicit mode (`cognitum-low|mid|high`).** Pins the tier; no routing, no escalation.
The key must hold the matching scope.

**What we replicate vs. what we don't** (per `SAKANA_FUGU…` §1.2, §1.4):

| Fugu                                              | Cognitum Fugu                                              |
|---------------------------------------------------|------------------------------------------------------------|
| Swappable pool of frontier LLMs                   | ✅ Replicated — per-tier pools, hot-reloadable config        |
| Tiered/role orchestration (Thinker/Worker/Verifier) | ◑ Partial — tier resolution + one-shot verifier escalation |
| **CMA-ES-trained 0.6B coordinator (TRINITY)**     | ❌ Not replicated — heuristic difficulty signal             |
| **GRPO-trained 7B Conductor / recursive topology**| ❌ Not replicated — bounded ReAct, fixed escalation depth   |
| Proprietary per-query selection                   | ❌ Ours is open, inspectable, logged per request            |

### 3.4 OpenAI-compatible shape

- **Request**: standard `model`, `messages`, `temperature`, `top_p`, `max_tokens`,
  `stream`, `tools`/`tool_choice`, `stop`, `n` (n=1 enforced in v1), plus three
  **namespaced routing controls** (all optional, also accepted as `X-Cognitum-*` headers):
  - `fallback_policy`: `fail_fast` (default for `auto`) | `best_effort` — behaviour when
    intrinsic difficulty needs a tier the key lacks (§6, item 2).
  - `min_tier`: `low|mid|high` — **quality floor** (never route below this tier).
  - `max_tier`: `low|mid|high` — **cost cap** (never escalate above this tier, even if τ
    fires). These are the **semantic** controls that replace exposing τ directly (§6.5).
- **Model field** is the routing dial: `cognitum-auto` | `cognitum-low` | `cognitum-mid`
  | `cognitum-high` | `cognitum-<tier>-agent` (bounded-ReAct agentic mode). Raw vendor
  model ids are **rejected** (404 `model_not_found`) — customers buy *tiers*, not models,
  so we keep the pool swappable without breaking clients.
- **Response**: standard `choices[]`, `usage{prompt_tokens, completion_tokens,
  total_tokens}`, plus a namespaced extension block:
  ```json
  "x_cognitum": { "request_id":"…", "resolved_tier":"high", "resolved_model":"claude-opus-4.8",
                  "escalated":true, "cap_degraded":false, "routing_reason":"difficulty>=high",
                  "price_usd":0.0042 }
  ```
- **Streaming**: SSE `text/event-stream`, `data: {chunk}` lines terminated by
  `data: [DONE]`, deltas in `choices[].delta` — byte-compatible with OpenAI SSE so
  existing SDKs (`stream=true`) work unmodified.
- **`GET /v1/models`** lists the four `cognitum-*` aliases (not the underlying pool).

**Routing-control header/field surface** (inputs the client sets; outputs we return):

| Direction | Field (body) / Header                    | Values                     | Meaning |
|-----------|------------------------------------------|----------------------------|---------|
| **in**    | `fallback_policy` / `X-Cognitum-Fallback-Policy` | `fail_fast` (auto default) · `best_effort` | scope-mismatch behaviour (§6.2) |
| **in**    | `min_tier` / `X-Cognitum-Min-Tier`       | `low|mid|high`             | quality floor |
| **in**    | `max_tier` / `X-Cognitum-Max-Tier`       | `low|mid|high`             | cost cap (caps τ escalation) |
| **out**   | `x_cognitum.resolved_tier` / `X-Cognitum-Resolved-Tier` | `low|mid|high` | tier that actually executed (the billed tier) |
| **out**   | `x_cognitum.cap_degraded` / `X-Cognitum-Cap-Degraded` | `true|false` | `best_effort` ran below the difficulty-implied tier |
| **out**   | `x_cognitum.routing_reason` / `X-Cognitum-Routing-Reason` | string (optional) | human-readable why-this-tier (τ effect, not τ value) |

τ itself is **never** an input or an output value — only its *effect* is observable via
`resolved_tier` / `routing_reason` (§6.5).

---

## 4. Tiering — model sets, rationale, price/SLA

### 4.1 Cost-vs-capability rationale (grounded, not hype)

From `PLACEMENT.md` (genuine metered grid, Retort DoE/ANOVA, scoring by Retort's
two-opinion conformance judge):

| stack                    | coverage (mean) | $/task   | latency | placement                |
|--------------------------|-----------------|----------|---------|--------------------------|
| `claude-code/frontier`   | **0.958**       | $1.232   | 170 s   | accuracy-optimal corner  |
| **`metaharness/cheap`** ⭐ | **0.954**       | **$0.102** | 481 s   | **cost-optimal corner**  |
| `metaharness/frontier`   | 0.944           | $1.076   | 262 s   | dominated (genuine view) |
| `claude-code/cheap`      | 0.451           | $0.254   | 148 s   | dominated                |

The honest reading (PLACEMENT §1, and Iteration 2/3/4 updates):

- **Cheap is genuinely frontier-class on everyday work** — `metaharness/cheap`
  (deepseek-v4-pro) reaches **0.954** coverage, statistically tied with the
  accuracy leader (0.958), at **~12× lower cost**. With the harness fixes (20-min cap +
  multi-action ReAct) the cheap-tier *pass-rate* doubled to 0.83–0.95. → **the `low`
  tier is a real product, not a loss-leader.**
- **But the cheap-tier capability ceiling is structural.** Iteration-4: swapping to the
  *best* cheap model (glm-5.2) is statistically identical on coverage (0.928 vs 0.935,
  base-model ANOVA effect 0.3%, p=0.70) — it buys *speed*, not the coverage needed to
  dominate. **No cheap configuration crosses 0.958.** → **the `high` tier exists because
  the gap is real on hard requests, not to upsell.**
- **Routing recovers most of the gap at a fraction of always-frontier cost.**
  Iteration-3: difficulty-aware escalation (33% of requests) lifted coverage
  0.836→0.927 and *killed all timeouts*. → **`cognitum-auto` is the validated default.**
- ANOVA: `cost_per_task` is **78.1%** governed by model choice — so **tier = the
  dominant cost lever**, which is precisely why we price and route on it.

### 4.2 Per-tier price / SLA (illustrative; finalized at launch)

Prices are **usage-metered $/1M tokens** with a margin over provider cost; the *shape*
(low ≪ mid < high) is fixed by the §4.1 data, the absolute numbers are a launch decision.

| Tier   | Input $/1M | Output $/1M | Default rate limit | Latency SLO (p95) | Escalation |
|--------|-----------:|------------:|--------------------|-------------------|------------|
| `low`  | cheapest   | cheapest    | 120 req/min        | ~8 s (non-stream) | n/a        |
| `mid`  | ~5–8×      | ~5–8×       | 60 req/min         | ~5 s              | → high     |
| `high` | ~12–25×    | ~12–25×     | 30 req/min         | ~5 s              | none       |
| `auto` | billed at *resolved* tier | — | min of held scopes | per resolved tier | low→mid→high |

Rate limits stay inside the production envelope (cognitum-one/api `api-keys.md`:
10–1000 req/min/key, 5000 req/min account ceiling, burst 2× for ≤30 s).

---

## 5. Metering & billing

### 5.1 Usage ledger + rollup (agentbbs-gcp pattern)

Reuses the **AgentBBS** Reporter→Pub/Sub→gen2-function→Firestore fold exactly
(`agentbbs-gcp/README.md`, `terraform/main.tf`) and the ADR-180 `darwin_runs` durable-
store idea:

```
apicompletions ──publish──► [Pub/Sub: completions-usage] ──► gen2 fn aggregateUsage
       │ (per request)                                              │ fold
       ▼ write                                                      ▼
 [Firestore] usage_ledger/{requestId}                  [Firestore] usage_rollups/{accountId}/{YYYY-MM}
```

- **`usage_ledger/{requestId}`** (one doc per request): `keyPrefix`, `accountId`,
  `tier`, `resolvedModel`, `promptTokens`, `completionTokens`, `totalTokens`,
  `priceUsd`, `escalated`, `latencyMs`, `ts`, `idempotencyKey`. Append-only; the
  billing source of truth.
- **`usage_rollups/{accountId}/{period}`**: folded totals by tier/model (mirrors
  `sysop_reports/latest` aggregation logic). Powers the dashboard usage chart that
  `manage.cognitum.one/api-keys` already renders per key.
- The publish is **fire-and-forget** off the hot path (the agentbbs sync-report /
  async-HTTP mpsc bridge); a metering failure logs but **never fails the customer's
  completion** — but the `usage_ledger` write is on the response path so billing is not
  lost (publish is the rollup, ledger is the truth).

**Progressive local token accounting (close the truncation billing hole).** Relying on
the provider's final SSE `usage` frame alone is a billing exploit: a client can consume
N tokens of `cognitum-high` output and then **drop the TCP connection before the final
frame arrives** → usage is never recorded → free inference. Mitigation: `apicompletions`
**tokenizes every outbound delta chunk locally and incrementally** — each delta is run
through an inline tokenizer (`js-tiktoken`, or a lightweight WASM tokenizer port) and a
running local `completion_tokens` counter is maintained as bytes stream out (prompt
tokens are known up front). On the response `close` / client-disconnect signal, the
service **assembles a partial usage record from the local counter** and writes it to
`usage_ledger` (flagged `truncated:true`), so a dropped stream is still billed for what
was actually generated. The provider's authoritative final count is **preferred when it
does arrive** (it reconciles the ledger row); the local counter is the **floor /
fallback**, never silently discarded.

### 5.2 Pricing computation

The ledger price is a **strictly linear pass on the resolved tier** — the tier that
actually executed, so an escalation `low→high` raises the charge to the `high` rate:

```
Price_USD = Input_tokens × Rate_In[resolved_tier] + Output_tokens × Rate_Out[resolved_tier]
```

- **Asymmetric in/out rates per tier**: `Rate_In[tier]` and `Rate_Out[tier]` are
  independent (output is typically the more expensive side), set per tier from §4.2.
- **`resolved_tier`, not requested tier**: escalation always bills at the tier that ran;
  a `low` request that escalated to `high` is charged at `high` and surfaces
  `resolved_tier=high` (§3.4) — no opaque double-charge, no cross-tier blending.
- **No vendor quirks leak in**: the formula is over *tiers*, never raw model ids or
  provider-specific surcharges; pool swaps inside a tier do not change the customer price.
- **Token source**: prompt/completion tokens come from the provider `usage` block when
  present, else from the local progressive counter (§5.1) — the same tokenizer used for
  routing and the truncation floor. Surfaced live in `x_cognitum.price_usd` and
  reconciled in the rollup.

### 5.3 Quota, rate-limit, idempotency

- **Rate limit / quota — scatter-gather, append-only (NOT single-doc transactional).**
  A single transactional sliding-window counter doc per `(keyHash, tier, window)` would
  hit Firestore's **~1 write/sec/document** contention wall: a high-throughput key firing
  many parallel streams serializes on that one doc → lock contention → transaction
  failures → retries → added latency *on the auth hot path*. Instead, each request writes
  an **ephemeral append-only tick** `api_keys/{keyHash}/usage_ticks/{tickId}` carrying a
  short **TTL** attribute (Firestore TTL policy auto-reaps it after the window), and the
  rate check is a fast Firestore **`COUNT()` aggregation query** over the current window
  (`ts >= now − window`) compared to the per-tier limit. Firestore handles high-frequency
  **subcollection creates** far better than single-doc transactional increments (no
  cross-instance lock), so this is **global** (fixing `security-review.md §1`'s
  per-instance `Map` under-enforcement) **without** re-introducing a hot-spot. Per-tier
  limits are unchanged (§4.2). Monthly token quota per account stays enforced from the
  rollup.
- **Idempotency**: optional `Idempotency-Key` header → `idempotency/{key}` doc with the
  cached response + status for a 24 h window; replays return the stored result (and are
  **not** re-billed). Critical for streaming retries.
- **Burst**: 2× configured limit for ≤30 s then strict, matching the documented key
  contract.

---

## 6. Auth — the REAL cognitum.one scheme (integrated, not fabricated)

Verified by inspecting `cognitum-one/api` (`docs/api-keys.md`, `docs/architecture.md`,
`docs/security-review.md`, `openapi/cognitum-api.yaml`). We integrate with it as-is:

| Property            | Production scheme (verified)                                              |
|---------------------|---------------------------------------------------------------------------|
| **Key format**      | `cog_` + **64 hex chars** (256-bit, `crypto.randomBytes(32)`)             |
| **Prefix**          | first 12 chars (`cog_3f7a8b9c`) — shown in dashboard, logs, errors         |
| **Headers**         | `X-API-Key: cog_…` (preferred) **or** `Authorization: Bearer cog_…`        |
| **Storage**         | Firestore **`api_keys`** collection, **SHA-256 hashed at rest**, indexed on `key` |
| **Per-key fields**  | `active`, `expiresAt`, `permissions[]` (scope allowlist), `rateLimit`, `prefix` |
| **Validation flow** | read header → SHA-256 → lookup `api_keys` → check `active`, `expiresAt`, `permissions.includes(scope)` |
| **Admin / issuance**| Firebase ID token on `/v1/admin/keys` (`manageApiKeys`); created at `manage.cognitum.one/api-keys`; plaintext shown **once** |
| **Audit**           | `audit_log` collection (`actor`, `action`, `targetId`, `prefix`, `createdAt`) |
| **Errors**          | uniform `{ error, code, requestId }`; 401 invalid key · 403 missing scope · 429 rate · 500 |
| **Limits**          | 10–1000 req/min/key · 5000 req/min account · 50 active keys/account         |

**Our additions (additive, no schema break):**

1. **Three new permission scopes** in the same `permissions[]` allowlist:
   `completions:low`, `completions:mid`, `completions:high`. A key may hold any subset.
   Tier-to-key binding is exactly the existing `permissions.includes('payments:create')`
   check (`security-review.md` "What we got right"), e.g.
   `permissions.includes('completions:high')`.
2. **Scope ↔ tier enforcement** (+ the auto-route scope-mismatch UX):
   - Explicit `cognitum-<tier>` → key must hold `completions:<tier>` → else **403**.
   - `cognitum-auto` → escalation is **capped at the highest tier the key holds** (a
     `low`-only key auto-routes but never escalates past `low`; a `low`+`high` key can
     escalate to `high`).
   - **Scope mismatch (difficulty needs a tier the key lacks).** When `cognitum-auto`
     judges a request's intrinsic difficulty to require, say, `high` but the key holds
     only `completions:low`, a **silent downgrade ships a likely-wrong answer and erodes
     trust**. The request controls this via the `fallback_policy` field/header (§3.4):
     - **`fail_fast` (default for `auto`)** — return **403** with a clear error envelope,
       e.g. `{"error":"Task difficulty requires cognitum-high tier, but this API key is
       limited to completions:low.","code":"tier_scope_insufficient","requestId":"…"}`.
       The client learns it needs a higher-scoped key rather than paying for a degraded
       answer.
     - **`best_effort`** — execute at the **highest tier the key holds** and set a
       prominent response header / field **`x_cognitum.cap_degraded: true`** (mirrored as
       `X-Cognitum-Cap-Degraded: true`), so the caller knows the answer ran below the
       difficulty-implied tier. Still billed at the tier that actually ran (§5.2).
3. **New gateway paths** added to the `architecture.md` path table:
   `POST /v1/chat/completions`, `POST /v1/completions`, `GET /v1/models` →
   upstream `apicompletions`, auth = API key.
4. **Dashboard**: `manage.cognitum.one` key-creation UI gains the three completion
   scopes (the existing `manageApiKeys` Firestore write — no new control plane).

Key material is **server-side only**: validated inside `apicompletions` on GCP, never
forwarded to model providers, never logged beyond the 12-char prefix (matching the
production logging contract: `requestId, path, apiKeyPrefix, upstream, latencyMs, status`).

**If the integration contract changes** (the above is what the repo shows today): the
only fields Cognitum Fugu *requires* from `api_keys` are `hash`, `active`, `expiresAt`,
`permissions[]`, `rateLimit`, `prefix`, and an `accountId` (for rollup attribution). If
`accountId` is not yet on the key doc, it must be added — that is the single integration
dependency on the cognitum-one/api team.

### 6.5 τ (escalation threshold) — internal + adaptive, never a public input

**Decision: τ stays internal and adaptive — it is MetaHarness-owned, calibrated from
data, and never exposed as a raw float in the public contract.** τ is the verifier
self-confidence threshold below which `cognitum-auto` re-answers once at the next tier
(§3.3). It is **calibrated from `usage_ledger` / PLACEMENT data** so that the cheap tier
absorbs the everyday-work mass and only the genuinely hard tail escalates (the §4.1
finding: cheap is frontier-class on everyday work, the gap is real only on hard requests).

**Why τ is not a public knob** — the same reasons raw vendor model ids are banned (§3.4):

- **Leaks an internal mechanism into the public contract.** A raw float exposes
  implementation detail customers would then depend on, freezing it.
- **Un-retunable as the pool swaps.** When the tier model pool changes, the *meaning* of a
  given τ value shifts; a baked-in client float would silently mis-route.
- **Gameable.** A caller could set τ to force-cheap (ship low answers as if vetted) or
  force-escalate (extract `high` quality while implying it was earned), defeating routing.

**What we expose instead — semantic controls, not the mechanism:**

- **`min_tier`** (quality floor) and **`max_tier`** (cost cap) — the customer-facing dials
  for "never go below X" / "never spend above Y"; `max_tier` also caps τ-driven escalation.
- **`fallback_policy`** (§6, item 2) for the scope-mismatch case.
- τ's **effect is observable but never its value**: `x_cognitum.resolved_tier` (the tier
  that ran) and optional `x_cognitum.routing_reason` (a human-readable why) let a client
  *see* what routing did without being able to *set* τ.

**Future path.** Because `usage_ledger` records resolved-tier + outcome per request, it is
exactly the corpus a future **Conductor-style trained router** (the deferred §11 item 3)
could bootstrap from once data accumulates — τ adaptation is the heuristic seed of that
learned head, not a competitor to it.

---

## 7. GCP deployment

### 7.1 Footprint (project `cognitum-20260110`, region `us-central1`)

- **Cloud Run `apicompletions`** — streaming-capable, `timeout=300s`,
  `concurrency=8` (long SSE streams hold a slot), `min-instances=0` (or 1 to dodge cold
  starts on a paid tier), `max-instances=20`. Behind `apigateway` via the existing path
  table; Phase C tightens it to `INTERNAL` ingress so only the gateway SA can invoke it
  (cognitum-one/api `security-review.md §2`).
- **Firestore (native)** — reuse the default DB: `api_keys` (reuse), `audit_log`
  (reuse), `usage_ledger` (new), `usage_rollups` (new),
  `api_keys/{keyHash}/usage_ticks` (new TTL'd subcollection — the scatter-gather rate
  counter, §5.3; needs a **TTL policy** on its `expireAt` field + a composite index for
  the windowed `COUNT()`), `idempotency` (new), `tier_config` (new). IAM-gated, no public
  client access (ADR-180 §3 posture).
- **Pub/Sub** — topic `completions-usage` + subscription, feeding…
- **Cloud Function gen2 `aggregateUsage`** — Pub/Sub-triggered, folds events into
  `usage_rollups` (the agentbbs-gcp `aggregateSysopReport` shape, `ALLOW_INTERNAL_ONLY`).
- **Service account `apicompletions-sa`** — least privilege:
  `roles/datastore.user`, `roles/pubsub.publisher`, `roles/secretmanager.secretAccessor`
  (mirrors ADR-180's `darwin-bench-writer` discipline).
- **Secrets (Secret Manager binding, not env)** — `OPENROUTER_API_KEY` and any direct
  provider keys, bound the way `STRIPE_SECRET_KEY` is (`deployment.md` §Secrets).

### 7.2 Terraform (reviewable; extends agentbbs-gcp)

A new module reuses the `agentbbs-gcp/terraform/main.tf` resources almost verbatim:
`google_project_service` (add `run`, `aiplatform` n/a — keep `run`, `firestore`,
`pubsub`, `cloudfunctions`, `cloudbuild`, `eventarc`), `google_firestore_database`
(already exists → `terraform import`, not create), `google_pubsub_topic.completions_usage`
+ subscription, `google_cloudfunctions2_function.aggregate_usage`, and a
`google_cloud_run_v2_service.apicompletions`. **`terraform plan` before any apply** — same
"reviewable config, do not blind-apply" rule as agentbbs-gcp and ADR-180.

### 7.3 Emulator-first dev ($0 — no paid runs)

Per AgentBBS ADR-0012 and `docker-compose.emulators.yml`: bring up the Firestore +
Pub/Sub emulators, export `FIRESTORE_EMULATOR_HOST` / `PUBSUB_EMULATOR_HOST`, and run
`apicompletions` against a **mock model provider** (canned token stream) so the entire
auth → tier → route → meter → bill loop is exercised offline at **$0**. A `cognitum-mock`
model alias stays available in non-prod for integration tests. Only a deliberate,
budgeted smoke test ever hits a real provider.

### 7.4 Rollout (GOAP-decomposed action plan)

Goal state: `{api_compatible, authed, tiered, metered, deployed, conformant}`.
Cost-ordered action sequence (preconditions → effects), A*-style critical path:

| # | Action                              | Preconditions                          | Effect (state delta)            |
|---|-------------------------------------|----------------------------------------|---------------------------------|
| 1 | Define OpenAPI for `/v1/chat/completions`, `/v1/completions`, `/v1/models` | — | `api_compatible` (spec)         |
| 2 | Add `completions:{low,mid,high}` scopes to `api_keys` + dashboard | scheme integrated (§6) | `authed`                        |
| 3 | Build `apicompletions` skeleton: auth middleware (reuse) + SSE passthrough | 1, 2 | `streaming`, partial `api_compatible` |
| 4 | Wire MetaHarness router (difficulty signal + per-tier pools + fallback) | 3 | `tiered`                        |
| 5 | Scatter-gather `usage_ticks` limiter (TTL + `COUNT()`) + idempotency | 3 | `rate_limited` (fixes sec-review §1, no hot-spot) |
| 6 | `usage_ledger` write + Pub/Sub publish + `aggregateUsage` fn | 3, Pub/Sub provisioned | `metered`                       |
| 7 | Emulator-first integration tests w/ mock provider ($0) | 3–6 | `tested` (no spend)             |
| 8 | Terraform plan + reviewed apply; gateway path mapping | 1–7 | `deployed`                      |
| 9 | Confidence-driven escalation (opt-in); honesty/conformance checks | 4, 6 | `conformant`, full `tiered`     |

Independent branches (parallelizable): {1}, {2}, {5} have no mutual deps; the critical
path is 3→4→6→8. Step 7 gates 8 (no deploy without green offline tests).

---

## 8. Conformance / honesty

- **Tiering is evidence-based, not marketing.** Every tier boundary and the auto-route
  default trace to measured numbers in `PLACEMENT.md` (Retort DoE, two-opinion
  conformance judge, real metered $; §4.1). The cheap tier's frontier-class everyday
  coverage (0.954 vs 0.958) and the structural high-tier gap (no cheap config > 0.958)
  are both *findings*, reported whichever way they landed (PLACEMENT explicitly logs
  "Beyond-SOTA: NO" four times).
- **No capability laundering.** `cognitum-auto` cannot present a `low` answer as `high`:
  the resolved tier and model are returned in `x_cognitum` and recorded in
  `usage_ledger`. Customers always see (and are billed for) what actually served them.
- **Honest Fugu framing.** We state plainly (§3.3) that we replicate tiered
  orchestration over a model pool and **do not** ship Fugu's trained coordinator; our
  routing is heuristic and inspectable. We do not claim Fugu's benchmark numbers.
- **Conformance firewall intact.** This is a serving product, not a benchmark harness —
  there is no gold-test loop to leak. The router's difficulty signal is *intrinsic to the
  request* (no oracle), exactly as ADR-201 §H5 and PLACEMENT §7 require.

---

## 9. Consequences

**Positive**
- One OpenAI-drop-in endpoint monetizes the org's core asset on infra and an auth system
  that already exist; clients point an existing SDK at `api.cognitum.one` and change a
  base URL.
- The cost dial is real and defensible: `low` serves everyday traffic at ~12× lower cost
  with frontier-class coverage; `auto` recovers most of the hard-task gap at a fraction
  of always-frontier spend.
- Reuses validated patterns (cognitum-one/api gateway+keys, agentbbs-gcp meter, ADR-180
  Firestore store), shrinking new surface to the completions service + router glue.
- Fixes a known production defect (per-instance rate limiter, sec-review §1) as a
  byproduct of needing global per-tier quotas.

**Negative / costs**
- New always-on-ish Cloud Run service (streaming holds slots → lower concurrency, higher
  cost than the scale-to-zero functions); cold-start vs min-instances is a cost knob.
- Pricing margin must beat provider cost *and* the latency reality from §4.1
  (MetaHarness cheap is 2–3× slower) — `low` is a *cost* play, not a *latency* play; the
  SLO table must be honest about that.
- Adds billing-critical state (`usage_ledger`) — needs reconciliation tooling and a
  metering-failure runbook.

---

## 10. Risks

| Risk | Mitigation |
|------|------------|
| Streaming exceeds Cloud Run timeout / drops mid-stream | 300 s timeout, heartbeat comments, idempotency-keyed resume, client retry guidance |
| **Client drops the stream before the final `usage` frame → free inference (billing exploit)** | Progressive local tokenization on every delta; on close/disconnect write a `truncated:true` partial usage record from the local counter (§5.1); provider final count preferred when it arrives, local counter is the floor |
| Rate limiter hot-spots / under-enforces | Scatter-gather TTL'd `usage_ticks` + `COUNT()` aggregation (§5.3) — global (fixes sec-review §1 per-instance bug) **and** dodges the ~1 write/sec/doc single-counter contention wall |
| Auto-route silently downgrades a hard request the key can't afford | `fallback_policy`: `fail_fast` default → 403 with a clear scope message; `best_effort` runs capped + flags `x_cognitum.cap_degraded` (§6, item 2) — never a silent wrong answer |
| Provider outage changes billed tier silently | Per-tier fallback chain (commit `de512bd`) stays *within* tier; tier never silently upgrades; escalation is explicit + surfaced |
| Token-count / price drift vs provider `usage` | Reconcile ledger against provider invoices; same tokenizer for routing + fallback counting |
| Prompt-injection / abuse over a public LLM endpoint | aidefence scan on inbound, per-key quotas, audit_log, leaked-`cog_`-key GitHub scanner (already run) |
| Escalation double-bills opaquely | Billed at *resolved* tier only; `x_cognitum.escalated` + ledger make it auditable |
| `accountId` missing on `api_keys` docs | Single named integration dependency on cognitum-one/api (§6) |

---

## 11. Alternatives considered

1. **Just proxy OpenRouter (thin passthrough).** Simplest, but gives up the entire value
   prop: no tier dial, no per-tier pricing/quota, no Cognitum-branded model surface, and
   it leaks vendor model churn to clients. The §4.1 data shows the *routing* is where the
   cost win lives; a passthrough captures none of it. **Rejected** as the product, kept
   as the `low`/`mid`/`high` provider backend.
2. **Per-model passthrough pricing** (charge cost+margin per raw model). Rejected: ties
   clients to vendor model ids, breaks pool swappability, and exposes vendor price
   volatility. Tier pricing decouples the product from the pool.
3. **Trained coordinator now (full Fugu / TRINITY-Conductor analog).** A CMA-ES/GRPO
   routing head would likely beat heuristic difficulty signalling — but we have neither
   the labelled routing data nor the need at launch, and PLACEMENT §H5 already showed an
   *off-the-shelf* semantic router was hard-detection-AUC≈chance. **Deferred:** the
   `usage_ledger` (resolved-tier + outcome per request) is precisely the training corpus
   a future "Cognitum Conductor" ADR would need — this design *bootstraps* it.
4. **Cloud Functions instead of Cloud Run for completions.** Rejected: gen2 functions
   are awkward for long-lived SSE; Cloud Run is the right primitive (the gateway is
   already Cloud Run). Functions remain correct for the Pub/Sub `aggregateUsage` folder.

---

## 12. Open questions

- Final absolute per-tier pricing (the §4.2 *shape* is fixed; the numbers are a launch
  call once provider costs + target margin are set).
- Whether `mid` is worth shipping at v1 or whether `low`/`high` + `auto` cover the curve
  (the DoE only measured two tiers — `mid` is an interpolation to validate post-launch).
- Verifier *design* and its cost/benefit (cost of the verifier pass vs the coverage it
  recovers — PLACEMENT §7's 33% escalation is the prior). The threshold **τ itself is
  decided** (§6.5): internal + adaptive, calibrated from `usage_ledger`/PLACEMENT, never a
  public input — only the verifier's mechanics and initial calibration window remain open.
- Region expansion beyond `us-central1` (latency for non-NA customers).

---

## Peer review addressed (rev 2)

This revision resolves the five peer-review items; the design is otherwise unchanged in
intent. Status stays **Proposed** but is now **ready for Approved**.

1. **Firestore hot-spotting (§2.5, §5.3, §7.1, §7.4-step5, §10).** Replaced single-document
   transactional sliding-window counters — which hit Firestore's **~1 write/sec/document**
   contention wall under a busy key (lock contention → transaction failures → retries →
   auth-hot-path latency) — with a **scatter-gather / append-only** structure: ephemeral
   TTL'd `api_keys/{keyHash}/usage_ticks/{tickId}` writes + a fast `COUNT()` aggregation
   over the current window. Still global (fixes sec-review §1), now without a hot-spot.
   Per-tier limits unchanged.

2. **Premature-stream-disconnect billing exploit (§5.1, §5.2, §10).** `apicompletions` now
   **tokenizes outbound deltas progressively and locally** (`js-tiktoken` / WASM port) with
   a running counter; on `close`/client-disconnect it writes a `truncated:true` partial
   usage record from that counter — so dropping the TCP connection before the final SSE
   `usage` frame no longer yields free inference. Provider's authoritative count is
   preferred when it arrives; the local counter is the floor/fallback.

3. **Auto-route scope-mismatch UX: fail-fast vs best-effort (§3.3, §6.2, §10).** Added the
   `fallback_policy` field/header: **`fail_fast`** (default for `auto`) returns **403** with
   a clear envelope (`"Task difficulty requires cognitum-high tier, but this API key is
   limited to completions:low."`); **`best_effort`** runs at the highest held tier and flags
   **`x_cognitum.cap_degraded: true`**. No more silent downgrade shipping a likely-wrong
   answer.

4. **Pricing formula (§5.2).** Stated as a strictly linear pass on the **resolved** tier:
   `Price_USD = Input_tokens × Rate_In[resolved_tier] + Output_tokens × Rate_Out[resolved_tier]`
   — asymmetric in/out rates per tier, escalation raises the charge, no vendor-specific
   quirks leak in.

5. **τ (escalation threshold) design (new §6.5; §3.3, §3.4, §12).** Decision: **τ stays
   internal + adaptive** (MetaHarness-owned, calibrated from `usage_ledger`/PLACEMENT),
   **never exposed as a raw float** (it would leak an internal mechanism, be un-retunable as
   the pool swaps, and be gameable — same rationale as banning raw vendor model ids). Exposed
   instead: **semantic** controls `min_tier`/`max_tier` + `fallback_policy`; τ's *effect* is
   observable via `x_cognitum.resolved_tier` (+ optional `routing_reason`), never as an input.
   A future Conductor-style trained router can bootstrap from `usage_ledger`.

Also bumped the OpenAI-compat request schema + a new routing-control header table (§3.4) to
carry the inputs (`fallback_policy`, `min_tier`, `max_tier`) and outputs
(`x_cognitum.resolved_tier`, `x_cognitum.cap_degraded`, `x_cognitum.routing_reason`).

**Remaining open dependency (unchanged):** the `accountId` field on cognitum-one/api
`api_keys` docs (§6, §10) — the single integration dependency on the cognitum-one/api team.
