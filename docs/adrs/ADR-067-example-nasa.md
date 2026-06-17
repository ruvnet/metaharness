# ADR-067: example-nasa — Space / Satellites SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Space-domain APIs are among the cleanest public data feeds available: NASA's
Open APIs are free, REST-based, richly documented, and require only a simple
API key (or the built-in `DEMO_KEY` for low-volume experimentation). They
cover planetary imagery (APOD — Astronomy Picture of the Day), real-time
Earth-observation event feeds (EONET — Earth Observatory Natural Event
Tracker), near-Earth object hazard data (NeoWs), Mars rover photography, and
the space-weather chronicles in DONKI. Alongside these REST feeds, the
`satellite.js` library (npm package `satellite.js`, v7.0.1 as of May 2026,
ESM-only) implements SGP4/SDP4 orbital propagation so an agent can ingest
Two-Line Element (TLE) sets from CelesTrak and compute satellite positions,
ground-track, and observer look-angles (azimuth / elevation / range) in pure
JavaScript without a server.

Together these two surfaces give an agent harness three concrete, verifiable
capabilities that span retrieval, computation, and event monitoring — exactly
the kind of multi-step workflow that exercises metaharness's tiered routing,
MCP default-deny gate, skill design, and verification primitives.

Because NASA Open APIs have no mutation surface (all endpoints are read-only
GET requests), and because `satellite.js` operates entirely on locally-held
TLE data, the safety posture is unusually clean: there is no billable action,
no data write, and no actuator to guard. The example still enforces the
standard ADR-051 safety frame (secrets via ENV, read-only by default, explicit
opt-in flags for any future mutation) so its patterns transfer directly to
platforms that do have mutation surfaces.

This is ADR-067, the sixteenth entry in the ADR-052–069 catalog defined by
ADR-051.

---

## Decision

### Chosen SDKs and direct HTTP

The example is wired to two primary packages and one free public data source:

| Layer | Package / endpoint | Version / notes |
|---|---|---|
| Orbital mechanics | `satellite.js` | v7.0.1, ESM-only (`import * as satellite from 'satellite.js'`) |
| NASA REST APIs | direct `fetch` to `https://api.nasa.gov/` | no wrapper needed; `nasa-sdk` is an alternative but unmaintained in recent years |
| TLE source | CelesTrak GP API (`https://celestrak.org/NORAD/elements/gp.php`) | no auth required; rate-limit: one download per 2-hour update cycle per IP per large group |

The choice of direct `fetch` over a wrapper package is deliberate: the NASA
Open APIs are stable REST endpoints, the response shapes are simple JSON, and
avoiding a wrapper eliminates a maintenance dependency. The `NASA_API_KEY`
environment variable is read at runtime and appended as the `api_key` query
parameter on every request; if unset the harness transparently falls back to
`DEMO_KEY` (30 req/hr / 50 req/day) and logs a warning. Registered keys
allow 1 000 req/hr with no daily cap.

### Headline capability

An end-to-end pass-prediction and imagery briefing workflow:

1. **APOD fetch** — retrieve today's (or a date-range of) Astronomy Picture of
   the Day image metadata and explanation text via `GET /planetary/apod`.
2. **EONET event scan** — retrieve currently open Earth-observation events
   (wildfires, storms, floods, etc.) from `GET https://eonet.gsfc.nasa.gov/api/v3/events`
   filtered by category, status, and bounding box.
3. **TLE ingest + pass prediction** — fetch TLE sets for a named satellite
   group from CelesTrak, parse them with `satellite.twoline2satrec()`, propagate
   orbital position with `satellite.propagate()`, convert to geodetic coordinates
   with `satellite.eciToGeodetic()` + `satellite.gstime()`, and compute observer
   look-angles with `satellite.ecfToLookAngles()` over a rolling time window to
   find the next visible pass above a configurable elevation threshold.

### Agent and skill design

Three specialised agents operate in a hierarchical topology:

| Agent | Tier | Responsibility |
|---|---|---|
| `space-planner` | Frontier (Sonnet/Opus) | Interprets the user's intent (date, location, satellite, event category), decomposes into sub-tasks, sets pass-prediction parameters, writes the mission brief |
| `space-executor` | Cheap (Haiku) | Executes all HTTP fetches (APOD, EONET, CelesTrak TLE), runs `satellite.js` propagation loop, assembles raw results |
| `space-verifier` | Cheap (Haiku) | Re-reads the raw API responses and computed pass data, cross-checks key fields (date match, elevation above threshold, event status = "open"), emits a structured verification report |

One slash command is defined:

- `/space-brief [--date YYYY-MM-DD] [--lat LAT] [--lon LON] [--satellite GROUP] [--category EONET_CATEGORY]`
  — triggers the full planner → executor → verifier pipeline and returns a
  formatted mission brief with APOD image URL, active EONET events, and the
  next predicted satellite pass for the observer's location.

### Routing tiers (ADR-026)

| Tier | Model | Tasks in this example |
|---|---|---|
| 1 (WASM booster) | none / local transform | TLE line parsing (pure JS transform, no LLM) |
| 2 (cheap) | Haiku | HTTP fetch, JSON extraction, `satellite.js` propagation loop, field-level verification |
| 3 (frontier) | Sonnet / Opus | Mission brief composition, intent disambiguation, natural-language explanation of EONET events, final synthesis |

### MCP policy (ADR-022 default-deny)

The scaffolded `.harness/mcp-policy.json` grants exactly the following tools
and denies all others:

```json
{
  "version": "1",
  "default": "deny",
  "audit": true,
  "grants": [
    { "tool": "fetch",        "comment": "NASA Open APIs + CelesTrak TLE" },
    { "tool": "read_file",    "comment": "read locally cached TLE files"  },
    { "tool": "write_file",   "comment": "write TLE cache and pass log"   },
    { "tool": "bash",         "scope": "readonly", "comment": "node --check only" }
  ]
}
```

`write_file` is granted only to the TLE cache path (`.harness/cache/tle/`)
and the pass-log path (`.harness/logs/passes.jsonl`). All network access is
restricted to the two whitelisted origins; MCP network tool calls to any other
host are denied. Every tool invocation is appended to `.harness/audit.jsonl`.

### Auth model

| Credential | Env var | Where to obtain | Fallback |
|---|---|---|---|
| NASA API key | `NASA_API_KEY` | `https://api.nasa.gov/` — free registration | `DEMO_KEY` (30 req/hr, 50 req/day) |
| CelesTrak | none required | Public endpoint | n/a |
| Observer location | `OBSERVER_LAT`, `OBSERVER_LON`, `OBSERVER_ALT_M` | Set manually | defaults: 37.7749° N, 122.4194° W, 0 m (San Francisco) |

No credentials are written to scaffolded files. The `.env.example` file lists
the variable names only; `.env` is always gitignored.

### Safety gates

- **All API calls are read-only GET requests.** NASA Open APIs have no write
  or mutation endpoints in the public surface. CelesTrak is similarly read-only.
- **`satellite.js` is pure computation** — no network calls, no file I/O.
- **No opt-in mutation flag is required** because no mutating capability
  exists. The safety posture is entirely about credential hygiene and rate-limit
  awareness.
- **Rate-limit guard**: the executor agent checks the `X-RateLimit-Remaining`
  response header after each NASA API call and backs off (with logged warning)
  if the value falls below 10. When `DEMO_KEY` is in use, the harness enforces
  a soft cap of 25 requests per session and prompts the user to register a key.
- **TLE freshness warning**: if the cached TLE epoch is more than 48 hours old
  the planner logs a staleness warning, because SGP4 accuracy degrades with
  TLE age. The harness does not auto-refresh large groups more than once per
  2 hours to respect CelesTrak's rate policy.

---

## Consequences

### Positive

- Demonstrates the full ADR-051 capability matrix (tiered routing, MCP
  default-deny, slash command, ≥2 agents, verification gate) on a platform
  that is entirely free, publicly accessible, and read-only — making it the
  safest possible entry point for new users.
- Orbital pass prediction via `satellite.js` is a non-trivial, deterministic
  computation that gives the verifier agent something concrete to check (did
  the computed elevation exceed the threshold at the predicted time?), making
  the verification gate meaningful rather than cosmetic.
- TLE data from CelesTrak covers thousands of active satellites; the `GROUP`
  parameter (STATIONS, STARLINK, ACTIVE, etc.) provides natural fan-out for
  swarm coordination patterns.
- No billing risk, no sandbox/production split needed, no regulated-domain
  disclaimer required.

### Honest limitations

- `satellite.js` v7 is ESM-only; consumers on older CommonJS toolchains must
  use a bundler or dynamic `import()`. The scaffolded harness targets Node
  >=20 which handles ESM natively.
- APOD returns one image per day; date-range queries return at most ~100 items
  per call. EONET does not require a NASA API key, so the key is only strictly
  necessary for APOD and NeoWs.
- CelesTrak imposes a 2-hour cooldown per IP for bulk group downloads; the
  harness caches TLE files locally to avoid repeated downloads within the
  cooldown window.
- SGP4 propagation accuracy degrades for objects in highly eccentric orbits
  or for very old TLEs. The harness is illustrative, not suitable for safety-
  critical orbital operations.
- `DEMO_KEY` is rate-limited to 30 requests per hour and 50 per day by IP
  address. Users running batch scenarios should register a free NASA API key.

### Not-for-production disclaimer

This example is an **illustrative showcase** of the metaharness framework
wired to publicly available space-data APIs. It is **not certified for
operational satellite tracking, collision avoidance, spectrum management, or
any safety-critical aerospace application**. Orbital data from CelesTrak and
computed pass predictions carry inherent uncertainty and must not be used for
flight planning, launch operations, or regulatory compliance without
authoritative sources and domain-certified software.
