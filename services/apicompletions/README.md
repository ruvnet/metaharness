# apicompletions — Cognitum Fugu

OpenAI-compatible, **metered**, **tiered** completions service for `api.cognitum.one`
(**ADR-203**). The honest analog of Sakana Fugu: tiered orchestration over a swappable
model pool, routed by MetaHarness's heuristic difficulty signal — **not** a trained
coordinator.

> **Status: skeleton.** This is the scaffolded service shell from the ADR-203 rollout
> (§7.4 step 3). Route handlers return `501 not_implemented`; pipeline modules are typed
> stubs. The skeleton builds, typechecks, and tests green.

## Stack

TypeScript / Node 20, **Express** + `node-fetch`, `tsc` (CommonJS / ES2022), **vitest** +
`supertest`, Docker `node:20-alpine` on **:8080** — the same stack as the
`@cognitum-one/api-gateway` upstream this service sits behind.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (SSE or JSON) |
| `POST` | `/v1/completions` | Legacy completions shape |
| `GET`  | `/v1/models` | Lists the four `cognitum-*` aliases (not raw vendor ids) |
| `GET`  | `/healthz` | Liveness |

Model dial: `cognitum-auto` (default) · `cognitum-low|mid|high` · `cognitum-<tier>-agent`.
Routing controls (body or `X-Cognitum-*` headers): `fallback_policy`, `min_tier`,
`max_tier`, `escalation`. Response carries an `x_cognitum` block (`resolved_tier`,
`escalated`, `cap_degraded`, `price_usd`, …). τ is internal/adaptive, never a public knob.

## Module map (`src/`)

| Dir | Responsibility (ADR §) |
|-----|------------------------|
| `server.ts` / `index.ts` | Express app + Cloud Run bootstrap (§7.1) |
| `routes/` | `/v1/chat/completions`, `/v1/completions`, `/v1/models` (§3.1, §3.4) |
| `auth/` | Real `cog_` SHA-256 → Firestore `api_keys` + `completions:<tier>` scopes (§6) |
| `tier/` | Model-alias → tier, scope enforcement, `fallback_policy` (§3.3, §6.2) |
| `router/` | Intrinsic difficulty signal (§3.3) + post-gen τ escalation (§6.5, non-stream only) |
| `providers/` | `ModelProvider` (OpenRouter / direct) + `MockProvider` ($0, §7.3) |
| `metering/` | Family-correct progressive tokenizer (§5.1) · ledger + Pub/Sub (§5.1) · pricing (§5.2) |
| `ratelimit/` | Scatter-gather `usage_ticks` + `COUNT()` debounce (§5.3) · idempotency |
| `midstream/` | Firewalled optional `ruvnet/midstream` inflight escalation (§3.5) — **degrades to Option B today** |
| `firestore/` | Emulator-aware Firestore handle (§7.1, §7.3) |
| `config/` | Env + Firestore `tier_config` pools (§3.2) |

Plus `functions/aggregateUsage/` (gen2 Pub/Sub rollup, §5.1) and `terraform/` (reviewable
module, §7.2 — **plan, never blind-apply**).

## Develop ($0, emulator-first)

```bash
npm install
npm run build            # tsc — green
npm test                 # vitest — green
docker compose -f docker-compose.emulators.yml up   # Firestore + Pub/Sub emulators
USE_MOCK_PROVIDER=true npm run dev                   # whole auth→tier→route→meter loop, no spend
```

## Notable design decisions (from ADR-203)

- **Streaming routes once, up front** on the intrinsic input signal (`stream_oneshot`,
  Option B) — post-gen τ escalation applies to non-streaming only (§3.3, §6.5).
- **Bill the resolved tier**; family-correct local token counting is the disconnect/
  truncation billing floor (provider's authoritative count preferred when it arrives) (§5.1).
- **`@midstream/wasm` is 404 on npm** — the inflight `escalation:"inflight"` path is dark
  and silently degrades to `stream_oneshot`; the firewall (`src/midstream/firewall.ts`) is
  the operative state, not an error path (§3.5).
- **Open integration dependency**: `accountId` on `api_keys` docs (§6, §10).

Deferred deps (added during Phase-1 impl, kept out of the skeleton): `firebase-admin`,
`@google-cloud/pubsub`, `js-tiktoken` + per-family tokenizers.
