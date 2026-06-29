# ADR-203 — Cognitum Fugu: a GCP-hosted, metered, tiered Completions API on MetaHarness

**Status:** Proposed (rev 4 — optional midstream inflight-streaming upgrade; ready for Approved)
**Date:** 2026-06-29
**Rev 4 note:** This revision adds an **OPTIONAL, firewalled** integration of
`ruvnet/midstream` for **inflight streaming escalation** (new §3.5 + a §10 risk row +
the `escalation:"inflight"` schema opt-in). It is **purely additive**: the rev-3
decision stands unchanged — **Option B (`stream_oneshot`, one-shot up-front routing on
the intrinsic INPUT signal) remains the default and the safe path**, and is the mandatory
degraded-mode fallback. midstream is a *removable augmentation* (ADR-150). Because the
`@midstream/wasm` package is **NOT published on npm today (404 verified)**, the
optional-dependency firewall **always degrades to Option B right now**; inflight
escalation is a *future-enabled* upgrade, off until the WASM is vendored from the repo or
published upstream.
**Rev 3 note:** This revision addresses a third peer-review round — the
**streaming-escalation paradox** (post-generation τ escalation is incompatible with
`stream:true`), **tokenizer drift across model families** (an OpenAI tokenizer cannot
count non-OpenAI model output), and the **Firestore `COUNT()` aggregation cost** at
scale. The streaming-vs-escalation question is now decided (§3.3, §6.5): streams route
**once, up front, on the intrinsic input signal**; only the non-streaming path runs
post-generation τ escalation. The one remaining open integration dependency is
unchanged: the `accountId` field on cognitum-one/api `api_keys` (§6, §10).
**Rev 2 note:** Rev 2 addressed the peer review — Firestore counter
throughput (hot-spotting on single-doc transactional increments), stream-truncation
billing leakage, the auto-route scope-mismatch UX (silent downgrade), the pricing
formula, and the τ escalation-threshold design.
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
   f. ESCALATE  (auto + opt-in, NON-STREAM / buffered only) verifier confidence < τ →
                re-answer at next tier (once). Streams route once up front (§3.3) — no
                post-gen re-answer; the input signal alone picks the streamed tier.
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

**Confidence-driven escalation (opt-in) — non-streaming only.** If a `low`/`mid`
answer's verifier self-confidence falls below the internal threshold **τ**, the harness
re-answers **once** at the next tier (capped by the key's scopes and the request's
`max_tier`). This maps loosely to Fugu's **Verifier** role — but it is a heuristic check,
not a learned head. **τ is an internal, adaptive, MetaHarness-owned mechanism, never a
public input** — its design and the reasons it is *not* exposed as a raw float are in
§6.5. Escalation is **always billed transparently** at the tier actually used and
surfaced in the response (`x_cognitum.escalated`, `x_cognitum.resolved_tier`, optional
`x_cognitum.routing_reason`).

**Streaming vs. escalation — the paradox, and the decision.** Post-generation τ
escalation is **fundamentally incompatible with `stream:true`**: by the time a verifier
could judge a `low` answer, its tokens have **already been sent to the client**. We
cannot un-send them, and we cannot switch to a higher-tier model mid-stream without
corrupting the OpenAI event-stream format (the SDK has already parsed `low`-tier deltas
into the assistant message). There is therefore **no post-generation τ re-answer for
streams.** Instead:

- **`stream:true` → one-shot routing decided *before* generation** on the **intrinsic
  INPUT difficulty signal** (the same pre-solve PLACEMENT §7 mechanism used for the
  starting-tier decision). This is **not capped to `low`**: if the input signal predicts
  a hard request, it routes to `high` **up front** and streams from `high` directly. The
  routing decision is made once, before the first token, and the entire stream comes from
  that one resolved tier. (`min_tier`/`max_tier` still bound it; scope rules still apply.)
- **`stream:false` → full post-generation τ escalation** is available: the response is
  buffered server-side, so re-answering at a higher tier is clean and invisible to the
  client (it only ever sees the final, possibly-escalated answer).
- **Opt-in Option A — `escalation:"buffered"`** lets a client get verifier-gated
  escalation *and* a streamed-shaped response: `apicompletions` **buffers the full
  response, runs the verifier (escalating once if τ fires), then flushes the final answer
  as an accelerated pseudo-stream**. This **explicitly trades time-to-first-token (TTFT)**
  — the client waits for the whole generation (plus a possible escalation pass) before the
  first byte arrives — so it is **never the default**; the TTFT cost is documented and
  must be opted into. Defaults: `escalation:"stream_oneshot"` for streams,
  `escalation:"post_hoc"` for non-streaming.
- **Rejected — Option C (speculative-stream-then-error).** Streaming the `low` answer
  optimistically and, if the verifier later rejects it, emitting an error/restart was
  **rejected**: it corrupts the SSE event-stream contract (the client has already
  committed `low` deltas to the assistant message), forces every SDK into a retry path
  that most clients do not implement, and **double-bills** — the discarded `low`-tier
  tokens were generated and metered, then thrown away. The contract breakage and the
  wasted spend make it strictly worse than deciding up front.

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
  - `escalation`: `stream_oneshot` (default for `stream:true`) | `post_hoc` (default for
    `stream:false`) | `buffered` — chooses the escalation strategy (§3.3). `stream_oneshot`
    decides the tier once on the input signal and never re-answers; `post_hoc` runs the
    verifier-gated re-answer on a buffered non-stream response; `buffered` opts a streaming
    client into verifier-gated escalation at the **cost of TTFT** (buffer → verify →
    pseudo-stream the final answer).
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
| **in**    | `escalation` / `X-Cognitum-Escalation`   | `stream_oneshot` (stream default) · `post_hoc` (non-stream default) · `buffered` | escalation strategy (§3.3); `buffered` trades TTFT for verifier-gated escalation on a streaming-shaped response |
| **out**   | `x_cognitum.resolved_tier` / `X-Cognitum-Resolved-Tier` | `low|mid|high` | tier that actually executed (the billed tier) |
| **out**   | `x_cognitum.cap_degraded` / `X-Cognitum-Cap-Degraded` | `true|false` | `best_effort` ran below the difficulty-implied tier |
| **out**   | `x_cognitum.routing_reason` / `X-Cognitum-Routing-Reason` | string (optional) | human-readable why-this-tier (τ effect, not τ value) |

τ itself is **never** an input or an output value — only its *effect* is observable via
`resolved_tier` / `routing_reason` (§6.5).

### 3.5 Inflight streaming via `ruvnet/midstream` — optional, firewalled

**Status of this subsection: OPTIONAL, additive, currently degraded to Option B.** It
*extends* — never replaces — the rev-3 streaming decision (§3.3). rev-3 stands:
**`escalation:"stream_oneshot"` (Option B — one-shot routing decided up front on the
intrinsic INPUT difficulty signal) is the default and the safe path.** Everything below
is a *firewalled optional upgrade* that is inert unless `ruvnet/midstream` is present at
runtime — and as of today it is *not* (item 2), so the system runs Option B.

**1. What it enables — a better Option C′ (inflight escalation).** rev-3 §3.3 *rejected*
Option C (speculative-stream-then-error) because, with no inflight analysis, the only way
to recover from a bad streamed `low` answer was to corrupt the SSE contract and force a
restart. `ruvnet/midstream` — a **real** Rust/WASM real-time inflight LLM-stream-analysis
toolkit (repo `ruvnet/midstream`, ~126★, actively developed: pushed 2026-06-29; layout
has `crates/`, `npm/`, `npm-wasm/`, `wasm/`, `wasm-bindings/`) — is the right *category*
of tool to change that calculus: it can **scan the streaming output as it is generated**
and, on an **early failure signal**, **escalate mid-stream without killing TTFT** (the
first tokens already flowed to the client). This **supersedes the rev-3 rejection of
Option C *only when midstream is present*** — call it **Option C′**. When midstream is
absent, the rev-3 rejection of Option C stands and **Option B remains both the default and
the fallback**.

**2. Optional-dependency firewall (ADR-150 removable-augmentation).** midstream is wired as
an `optionalDependency` behind a dynamic-import firewall — exactly the ADR-150 pattern of a
clever mechanism that is a *removable* augmentation, never a required runtime dep:

```js
let midstream = null;
try { midstream = await import('@midstream/wasm'); }   // future-enabled
catch { midstream = null; }                            // → degrade to Option B
// the inflight path runs ONLY if midstream !== null; otherwise escalation:"inflight"
// silently behaves as escalation:"stream_oneshot" (Option B).
```

**Degraded mode === Option B, fully operational without midstream — and this is the
*current* operative state.** `@midstream/wasm` is **NOT published on npm (404 verified,
2026-06-29)**, so the dynamic import above **fails today** and the service **always falls
back to Option B**. Enabling Option C′ therefore first requires *either* building the WASM
bundle from the repo's `npm-wasm/` / `wasm/` directory and vendoring it, *or* awaiting an
upstream npm publish. Until then the firewall is doing its job: inflight escalation is
dark and Option B (rev-3) serves every stream.

**3. SDK-safe truncation protocol (the mid-stream handoff).** When midstream's inflight
scan fires an escalation, we must hand off to the higher tier **without** leaving
third-party SDKs in a broken parse state (the `Unexpected end of JSON input` failure mode).
Protocol:

1. Emit **one OpenAI-event-stream-conformant terminal chunk** on the low-tier stream with
   `choices[].finish_reason: "content_filter"` (or `"length"` where more apt) — a value
   existing SDKs already treat as a clean stop.
2. Attach a **namespaced** block on that terminal chunk:
   `x_cognitum: { escalated: true, resolved_tier: "<higher>", next_context: "<continuation handle>" }`.
3. Send `data: [DONE]` so the SDK **closes its stream loop gracefully** — no dangling JSON.
4. The **higher tier then continues** the answer (the client reconnects on `next_context`,
   or the service bridges to a fresh higher-tier stream under the same `request_id`).

**Double-billing consideration (honest).** Only the **discarded early low-tier tokens** are
wasted spend — and inflight detection *minimizes* exactly that prefix (the earlier the
signal, the fewer tokens thrown away), which is precisely the advantage of doing this
inflight rather than post-hoc. Billing follows the rev-2 pricing rule: **bill the
resolved/escalated tier** for the delivered answer, and **record the discarded low-tier
prefix honestly** in `usage_ledger` (`escalated:true`, plus a `discarded_prefix_tokens`
field counted with the §5.1 family-correct progressive tokenizer). No capability
laundering, no hidden charge: the wasted prefix is visible in the ledger.

**4. Complementary uses (cross-ref rev-3; framed as "can", not "required").** midstream's
zero-copy byte matching and in-memory scheduling overlap two rev-3 mechanisms. In both
cases midstream *can* serve the role but is **not** required:

- **§5.1 billing floor.** midstream's zero-copy byte matching **can** supply the
  per-model-family **byte→token ratio** that rev-3 already calls for as the
  tokenizer-drift safety factor — i.e. an inflight, family-aware byte counter feeding the
  disconnect/truncation billing floor.
- **§5.3 `COUNT()`-debounce cache.** midstream's in-memory scheduler / priority-queue
  **can** back the instance-local debounce cache rev-3 specifies for the per-key `COUNT()`
  rate check.

Neither replaces the rev-3 serverless default; they are offered as *if-present* substrates.

**5. Phasing + scope discipline (HONEST — measured, not assumed).**

- **Phase 1 — only the concrete/verifiable uses:** (a) **billing-floor token tracking**,
  and (b) **basic inflight pattern detection** — loops, explicit refusals, and obvious /
  structural errors — as the early SDK-safe-truncation trigger. These are *early-detectable
  failure modes*, observable from the byte/token stream without a model of answer quality.
- **Phase 3 — deferred until validated on real `usage_ledger` data:** the exotic
  dynamical-systems crates **and** the "early confidence score from the first 20–30 tokens"
  claim. Per this project's own measured findings — **cognition-evolve null, memory null,
  scaffolding backfire** (see `[[retort-doe-benchmark]]` / ADR-201) — **clever mechanisms
  must be *measured*, not assumed.** Phase 1 is therefore scoped to *early-detectable
  failure modes only*, **not a confidence-threshold magic number**: we do not ship a
  "first-N-tokens confidence" gate until `usage_ledger` data shows it actually predicts
  escalation outcomes.

**6. Crate names are illustrative / to-be-confirmed.** The proposal's crate names —
`temporal-compare`, `midstreamer-scheduler`, `midstreamer-attractor`, `strange-loop` — are
**unverified** against midstream's published API. This integration is written **against
midstream's *actual* API as a contract** (inflight scan → escalation signal → SDK-safe
truncation → higher-tier continuation); the specific crate names above are *illustrative*
and must be confirmed against the repo before any wiring.

**7. Schema opt-in.** A fourth `escalation` value is added (extending the rev-3 §3.4 enum
`stream_oneshot | post_hoc | buffered`):

- **`escalation:"inflight"` (midstream-only).** Opt into inflight scan + mid-stream
  Option C′ escalation. **Silently falls back to `stream_oneshot` (Option B) when midstream
  is absent** (the current default state, per item 2). It is **never** the default; the
  default for `stream:true` remains `stream_oneshot`.

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
through an inline tokenizer and a running local `completion_tokens` counter is maintained
as bytes stream out (prompt tokens are known up front). On the response `close` /
client-disconnect signal, the service **assembles a partial usage record from the local
counter** and writes it to `usage_ledger` (flagged `truncated:true`), so a dropped stream
is still billed for what was actually generated. The provider's authoritative final count
is **preferred when it does arrive** (it reconciles the ledger row); the local counter is
the **floor / fallback**, never silently discarded.

**Tokenizer must match the resolved model's family — never count non-OpenAI output with
an OpenAI tokenizer.** `js-tiktoken` only models OpenAI encodings (`cl100k_base`,
`o200k_base`). The `low` tier's `deepseek-v4-pro` / `glm-5.2` use **different BPE schemes
and larger vocabularies**; running their output through an OpenAI profile produces a
**15–30 % local token-count drift**, which (because the local counter is the
truncation/disconnect billing floor) would systematically mis-bill the cheap tier. Fix:
the progressive local tokenizer is **dynamically selected by the `resolved_model`
family** — load the matching tokenizer (DeepSeek / GLM / OpenAI-encoding / etc.) for the
model that actually served the request. If shipping multiple WASM tokenizer bundles is
too heavy for the Cloud Run image, fall back to a **conservative, model-family-specific
byte→token ratio safety factor** applied to the streamed byte length as the **billing
floor** (per-family ratios, not a single global constant). In all cases the **provider's
authoritative final count is preferred when it arrives**; the correct-family local
estimate is only the floor / disconnect-fallback (the same reconciliation rule as the
stream-truncation fix above). Concretely: **an OpenAI tokenizer must not be used to count
the output of a non-OpenAI model** — the family must be resolved first.

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
- **`COUNT()` aggregation cost — debounce + bucket (cost ceiling at scale).** Firestore
  bills a `COUNT()` aggregation at **~1 read per 1,000 index entries matched**, so a
  high-volume key — checked on *every* request — would otherwise scan its whole window
  each time and run up a **steep Firestore read bill at scale**. Two mitigations keep the
  serverless default cheap:
  - **Short in-memory, instance-local cache** (≈500 ms–1 s TTL) on the per-key `COUNT()`
    result. Repeated window lookups within a Cloud Run instance are **debounced** to the
    cached value, bounding aggregation reads to **~1–2/sec/instance/key regardless of
    request rate** instead of one read per request.
  - **Bucket ticks into 1-minute docs/keys** — group `usage_ticks` into per-minute bucket
    docs so the window scan touches a **bounded set of index entries** (count the handful
    of minute-buckets in the window, not every individual tick), keeping each `COUNT()`
    cheap as volume grows.
  At massive enterprise scale, **Memorystore (Redis)** is the natural counter store, noted
  as the scale-out option — but the **pure-serverless default stays in-memory debounce +
  bucketed ticks** (no extra always-on infra). The debounce makes the limiter slightly
  **soft**: a key can briefly **over-admit within the cache window** (a burst arriving
  inside the ≤1 s TTL is admitted against a stale count). This is an **acceptable,
  documented trade** — the cost and auth-hot-path-latency win outweighs ≤1 s of bounded
  over-admission, and the per-tier burst allowance (§4.2) already absorbs it.
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

**τ governs only the non-streaming (post-generation) path.** Because a streamed answer's
tokens are already on the wire before any verifier could judge them, **τ does not apply to
`stream:true`** (§3.3): streams are routed **once, before generation, on the intrinsic
INPUT difficulty signal** — which can itself select `high` up front if the input predicts
a hard request. τ therefore drives escalation only for `escalation:"post_hoc"`
(non-streaming, buffered response) and the opt-in `escalation:"buffered"` pseudo-stream;
the streaming default `escalation:"stream_oneshot"` makes a single pre-gen tier decision
and never re-answers. This keeps τ's "internal mechanism, semantic controls only" contract
intact across both paths — the pre-gen input signal and post-gen τ are the same
difficulty machinery applied at different points in the request lifecycle.

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
| **Post-gen τ escalation is impossible mid-stream (tokens already sent; can't switch model without corrupting the SSE contract)** | `stream:true` routes **once up front on the intrinsic input signal** (can pick `high` directly) — no post-gen re-answer; `stream:false` keeps full τ escalation on the buffered response; opt-in `escalation:"buffered"` trades TTFT for verifier-gated streaming. Speculative-stream-then-error (Option C) rejected — contract breakage + double-bill (§3.3, §6.5) |
| **Tokenizer-family drift — OpenAI tokenizer mis-counts non-OpenAI (deepseek/glm) output by 15–30%** | Progressive tokenizer **selected by `resolved_model` family**; if multi-bundle WASM too heavy, a conservative **per-family byte→token ratio** as billing floor; provider's authoritative count always preferred; OpenAI encodings never used for non-OpenAI output (§5.1) |
| **Firestore `COUNT()` read cost (~1 read/1,000 entries) on a hot key checked every request** | Instance-local **≈500 ms–1 s debounce** of the per-key COUNT (~1–2 reads/sec/instance/key) + **1-minute bucketed ticks** (bounded scan); Memorystore the scale-out option; debounce accepted as a slightly-soft limiter (bounded ≤1 s over-admission) (§5.3) |
| Auto-route silently downgrades a hard request the key can't afford | `fallback_policy`: `fail_fast` default → 403 with a clear scope message; `best_effort` runs capped + flags `x_cognitum.cap_degraded` (§6, item 2) — never a silent wrong answer |
| Provider outage changes billed tier silently | Per-tier fallback chain (commit `de512bd`) stays *within* tier; tier never silently upgrades; escalation is explicit + surfaced |
| Token-count / price drift vs provider `usage` | Reconcile ledger against provider invoices; same tokenizer for routing + fallback counting |
| Prompt-injection / abuse over a public LLM endpoint | aidefence scan on inbound, per-key quotas, audit_log, leaked-`cog_`-key GitHub scanner (already run) |
| Escalation double-bills opaquely | Billed at *resolved* tier only; `x_cognitum.escalated` + ledger make it auditable |
| **Optional midstream inflight upgrade depends on an unpublished package + an unverified API** | `@midstream/wasm` is **not on npm (404 verified)** and the proposal's crate names are unverified — so the `optionalDependency` firewall **always degrades to Option B** (rev-3 default) until the WASM is vendored from the repo's `npm-wasm/`/`wasm/` dir or published; written against midstream's *actual* API as a contract; graceful-degradation is the default state, not an error path. Phase 1 limited to early-detectable failure modes; confidence-score claims deferred to Phase 3 pending `usage_ledger` validation (§3.5) |
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
  **The streaming-vs-escalation question is now decided** (rev 3, §3.3/§6.5): `stream:true`
  routes once up front on the intrinsic input signal, post-gen τ escalation is
  non-streaming-only, and `escalation:"buffered"` is the opt-in TTFT-trading bridge — no
  longer open.
- Region expansion beyond `us-central1` (latency for non-NA customers).

---

## Peer review addressed (rev 5)

This revision is **purely additive** — it makes the service **dual-protocol** by adding an
**Anthropic Messages API** surface alongside the rev-1 OpenAI surface, and **changes none of
the prior decisions**. **No OpenAI-protocol behaviour changes**; the §3.3 streaming decision,
§5 metering/billing, §6 auth/scope rules, and the §3.5 midstream upgrade all apply identically
across both protocols. Status stays **Proposed (rev 5)**.

1. **Anthropic Messages API surface (new §3.6; §3.4 endpoint/header update; §10 row).** Adds
   `POST /v1/messages` (+ `POST /v1/messages/count_tokens`) so **Claude Code** and Anthropic-SDK
   clients work against Cognitum Fugu with `ANTHROPIC_BASE_URL=https://api.cognitum.one/<base>`
   + `ANTHROPIC_API_KEY=cog_…`. Both protocols ride the **same** auth / router / metering /
   budget / streaming core — a thin translation shell, not a second engine.

2. **Auth reuses the existing `cog_` middleware.** Claude Code's `x-api-key` header is matched
   by the rev-1 **case-insensitive** `X-API-Key` middleware (§6), so `cog_…` keys +
   `completions:{low,mid,high}` scopes work unchanged; `anthropic-version` is **accepted and
   safely ignored**. No new auth system.

3. **Model→tier mapping accepts both dialects.** `cognitum-{auto,low,mid,high}` **and** real
   Anthropic ids — `opus*→high`, `sonnet*→mid`, `haiku*→low` (table in §3.6). `min_tier`/
   `max_tier` + the `fail_fast`/`best_effort` tier-scope rules (§6) apply identically. Raw
   arbitrary vendor ids resolve via the tier map, **never** passthrough.

4. **Request/response translation + streaming (the real work).** Maps the Anthropic
   `{model, max_tokens, system, messages, stream, …}` shape ↔ the internal canonical request,
   and renders the result to `{id, type:"message", role:"assistant", content:[{type:"text",
   text}], model, stop_reason, stop_sequence, usage:{input_tokens, output_tokens}}`. A
   stream-translation adapter synthesizes the Anthropic SSE sequence (`message_start` →
   `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` →
   `message_stop`, with `ping`s) from **any** backend incl. non-Anthropic (deepseek/gpt via
   OpenRouter). The §5.1 disconnect-billing floor applies to the Anthropic stream too, with the
   tokenizer family = the **resolved** model's family (not Anthropic's) for non-Anthropic
   backends. `usage` maps to the resolved-tier pricing ledger (§5.2).

5. **Honesty guard (§3.6, §10).** When `cognitum-auto`/`low` routes a Claude-Code request to a
   non-Anthropic cheap model, the translated response is **NOT Claude** and is never presented
   as such — the actual resolved model is surfaced in `model` / `x_cognitum.resolved_tier` /
   `resolved_model` and recorded in `usage_ledger` (same no-capability-laundering rule as §8,
   now across the translation boundary). New §10 row covers protocol-translation fidelity /
   SSE-shape correctness for Claude Code's parser.

**Remaining open dependency:** unchanged — the `accountId` field on cognitum-one/api `api_keys`
docs (§6, §10), plus the rev-4 firewalled midstream-publish/vendor dependency (degrades safely
to Option B). The dual-protocol addition introduces no new external dependency.

---

## Peer review addressed (rev 4)

This revision is **purely additive** — it adds an **OPTIONAL, firewalled** integration of
`ruvnet/midstream` for inflight streaming escalation and **changes none of the rev-3
decisions**. **Option B (`stream_oneshot`, one-shot up-front routing on the intrinsic INPUT
signal) remains the default and the safe path**, and is also the mandatory degraded-mode
fallback. Status stays **Proposed (rev 4)**.

1. **Inflight streaming via `ruvnet/midstream` — optional, firewalled (new §3.5; §10 row;
   §3.4 schema opt-in).** `ruvnet/midstream` is a **real** Rust/WASM inflight LLM-stream-
   analysis toolkit (~126★, actively developed, repo has `crates/`/`npm/`/`npm-wasm/`/
   `wasm/`/`wasm-bindings/`) — the right *category* of tool for inflight escalation. It
   enables a **better Option C′** than rev-3's rejected Option C: scan the streaming output
   inflight and, on an early failure signal, **escalate mid-stream without killing TTFT**.
   This supersedes the rev-3 Option-C rejection **only when midstream is present**; rev-3
   Option B is the default *and* the fallback.

2. **Honest dependency status: `@midstream/wasm` is NOT published on npm (404 verified).**
   The blueprint's `import('@midstream/wasm')` fails today, so the `optionalDependency`
   firewall (ADR-150 removable-augmentation) **always degrades to Option B right now**.
   Enabling Option C′ first requires building the WASM from the repo's `npm-wasm/`/`wasm/`
   dir and vendoring it, or awaiting an upstream publish. The crate names from the proposal
   (`temporal-compare`, `midstreamer-scheduler`, `midstreamer-attractor`, `strange-loop`)
   are **unverified** — the integration is written against midstream's *actual* API as a
   contract, the crate names are illustrative/to-be-confirmed.

3. **SDK-safe truncation protocol (§3.5 item 3).** Mid-stream escalation emits an
   OpenAI-conformant terminal chunk (`finish_reason:"content_filter"`/`"length"`) +
   `x_cognitum:{escalated,resolved_tier,next_context}` + `data: [DONE]` so third-party SDKs
   close their loop cleanly (no `Unexpected end of JSON input`); the higher tier then
   continues. **Double-billing:** only the discarded early low-tier prefix is wasted
   (minimized by early detection); bill the resolved tier (rev-2 rule), record the discarded
   prefix honestly in `usage_ledger`.

4. **Measured-not-assumed scope discipline (§3.5 item 5).** **Phase 1** ships only the
   concrete/verifiable uses — billing-floor token tracking + basic loop/refusal/obvious-error
   inflight detection for early SDK-safe truncation. **Phase 3** defers the exotic
   dynamical-systems crates **and** the "early confidence score from the first 20–30 tokens"
   claim until validated on real `usage_ledger` data — per this project's measured findings
   (cognition-evolve null, memory null, scaffolding backfire; `[[retort-doe-benchmark]]` /
   ADR-201), clever mechanisms must be **measured, not assumed**. Phase 1 is scoped to
   early-detectable failure modes only, not a confidence-threshold magic number.

5. **Schema opt-in (§3.4 / §3.5 item 7).** Adds `escalation:"inflight"` (midstream-only) to
   the rev-3 `stream_oneshot|post_hoc|buffered` enum; **silently falls back to
   `stream_oneshot` (Option B) when midstream is absent.**

**Complementary (if-present, not required):** midstream zero-copy byte matching *can* supply
the §5.1 per-family byte→token ratio; its in-memory scheduler *can* back the §5.3
`COUNT()`-debounce cache (§3.5 item 4).

**Remaining open dependency:** unchanged — the `accountId` field on cognitum-one/api
`api_keys` docs (§6, §10) — plus the new, firewalled midstream-publish/vendor dependency,
which degrades safely to Option B until resolved.

---

## Peer review addressed (rev 3)

This revision resolves a third peer-review round (three items); the design is otherwise
unchanged in intent. Status stays **Proposed** but is now **ready for Approved**.

1. **Streaming escalation paradox (§3.1-step f, §3.3, §3.4, §6.5, §10).** Post-generation τ
   escalation is **incompatible with `stream:true`** — the tokens are already sent, can't be
   un-sent, and the model can't be switched mid-stream without corrupting the OpenAI
   event-stream format. **Decision:** `stream:true` is **routed once, before generation, on
   the intrinsic INPUT difficulty signal** (the pre-solve PLACEMENT §7 mechanism) — and this
   is **not capped to `low`**: if the input predicts a hard request it routes to `high`
   up front and streams from `high`. There is **no post-gen τ re-answer for streams**.
   `stream:false` keeps the **full post-generation τ escalation** (buffered response →
   clean re-answer). Added the opt-in **`escalation:"buffered"`** (default
   `"stream_oneshot"` for streams / `"post_hoc"` for non-stream): buffer the full response,
   run the verifier, then flush as an accelerated pseudo-stream — **explicitly trades TTFT,
   never the default**, TTFT cost documented. **Rejected Option C** (speculative-stream-then
   -error): corrupts the event-stream contract, forces SDK retries, and double-bills
   discarded low-tier tokens. §6.5 now scopes τ to the non-streaming post-gen path; the
   request schema + header table (§3.4) carry the new `escalation` control.

2. **Tokenizer drift across model families (§5.1, §10).** `js-tiktoken` only models OpenAI
   encodings (`cl100k`/`o200k`); the `low` tier's `deepseek-v4-pro` / `glm-5.2` use different
   BPE schemes + larger vocabularies → **15–30 % local-count drift** if billed with an OpenAI
   profile (and the local counter is the truncation/disconnect billing floor). **Fix:** the
   progressive local tokenizer is **dynamically selected by the `resolved_model` family**;
   if multi-bundle WASM is too heavy for the Cloud Run image, fall back to a **conservative,
   model-family-specific byte→token ratio** as the billing floor. Provider's authoritative
   final count always preferred; the correct-family local estimate is the floor/disconnect
   fallback. Made explicit: **an OpenAI tokenizer must NOT be used to count non-OpenAI model
   output.**

3. **Firestore `COUNT()` aggregation cost (§5.3, §10).** `COUNT()` is billed ~**1 read per
   1,000 index entries matched**; a hot key checked on every request → steep read cost at
   scale. **Fix:** a **short in-memory, instance-local cache (≈500 ms–1 s)** debounces the
   per-key COUNT (bounds reads to ~1–2/sec/instance/key regardless of request rate), and
   ticks are grouped into **1-minute bucket docs** so the window scan touches bounded index
   entries (count buckets, not every tick). **Memorystore (Redis)** noted as the
   at-massive-scale option, but the **pure-serverless default is the in-memory debounce +
   bucketed ticks**. Acknowledged the debounce makes the limiter slightly **soft** (brief,
   bounded ≤1 s over-admission within the cache window) — an acceptable, documented trade.

§12 updated: the **streaming-vs-escalation question is now decided** (no longer open). Status
note bumped to **rev 3**.

**Remaining open dependency (unchanged):** the `accountId` field on cognitum-one/api
`api_keys` docs (§6, §10).

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
