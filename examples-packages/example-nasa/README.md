# @metaharness/example-nasa

**Space-data agent harness — APOD imagery, EONET Earth events, and satellite pass prediction from TLE**

> **Illustrative output notice**: All agent responses, pass-prediction times, and event summaries in this README are example outputs generated during development. Actual results depend on live NASA API data and current TLE epochs. This showcase is not certified for operational satellite tracking or any safety-critical aerospace application.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-nasa?style=flat-square)](https://www.npmjs.com/package/@metaharness/example-nasa)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-nasa?style=flat-square)](https://www.npmjs.com/package/@metaharness/example-nasa)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org/)
[![Built with MetaHarness](https://img.shields.io/badge/built%20with-metaharness-blueviolet?style=flat-square)](https://github.com/ruvnet/agent-harness-generator)

---

## Intro

`@metaharness/example-nasa` scaffolds a ready-to-run AI agent harness pre-wired to NASA's Open APIs and the `satellite.js` SGP4/SDP4 orbital-mechanics library. One `npx` command creates a project with:

- Three specialised agents (`space-planner`, `space-executor`, `space-verifier`)
- A `/space-brief` slash command that delivers a mission brief — today's APOD image, active EONET Earth-observation events, and the next visible satellite pass for your location
- Tiered model routing (cheap model for data fetching, frontier model for synthesis)
- MCP default-deny policy granting only the tools this harness actually needs
- A verification gate that re-reads API responses and recomputes pass elevation before marking the brief as done
- Host adapter wiring for every supported metaharness host via `--host`

**What it is NOT**: a production satellite-tracking system, a certified orbital-operations tool, or a replacement for authoritative aerospace data services. It is a concrete, runnable demonstration of the metaharness SDK-showcase pattern applied to space data.

---

## Features

| Capability | Detail |
|---|---|
| **APOD imagery retrieval** | Fetch Astronomy Picture of the Day (image or video) with title, explanation, copyright, and HD URL via `GET /planetary/apod` |
| **Date-range APOD** | Retrieve a batch of APOD entries (`--start-date` / `--end-date`) for historical browsing |
| **EONET event scan** | Query currently open or recent Earth-observation events (wildfires, storms, floods, volcanic activity) with category, bounding-box, and magnitude filters |
| **TLE ingest from CelesTrak** | Fetch Two-Line Element sets for named satellite groups (ISS, STARLINK, ACTIVE, etc.) from the CelesTrak GP API — no auth required |
| **SGP4 orbital propagation** | Parse TLEs with `satellite.twoline2satrec()`, propagate with `satellite.propagate()`, convert to geodetic lat/lon/alt with `satellite.eciToGeodetic()` + `satellite.gstime()` |
| **Observer look-angles** | Compute azimuth, elevation, and range from your ground position with `satellite.ecfToLookAngles()` |
| **Pass prediction** | Roll a time window forward in configurable steps to find the next pass above a minimum elevation threshold |
| **Tiered model routing** | Haiku for fetching and extraction; Sonnet/Opus for mission-brief composition and natural-language EONET summaries |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only `fetch`, `read_file`, `write_file` (cache paths only), and read-only `bash` |
| **Verification gate** | `space-verifier` agent re-reads raw API responses and recomputes peak elevation before presenting the brief as done |
| **Multi-host scaffold** | `--host all` emits configs for claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, rvm |

---

## Quickstart

```bash
npx @metaharness/example-nasa@latest my-space-bot
cd my-space-bot
npm install
npm run doctor
```

`npm run doctor` validates your environment: Node version, env var presence (with `DEMO_KEY` fallback notice), and a live APOD ping.

---

## Configuration

### Environment variables

| Variable | Required | Description | Where to get it |
|---|---|---|---|
| `NASA_API_KEY` | Recommended | Your NASA Open API key. If unset, the harness uses `DEMO_KEY` (30 req/hr, 50 req/day). | Free registration at [api.nasa.gov](https://api.nasa.gov/) |
| `OBSERVER_LAT` | Optional | Observer latitude in decimal degrees (default: `37.7749`) | Your GPS coordinates |
| `OBSERVER_LON` | Optional | Observer longitude in decimal degrees (default: `-122.4194`) | Your GPS coordinates |
| `OBSERVER_ALT_M` | Optional | Observer altitude in metres above sea level (default: `0`) | Your elevation |

Copy `.env.example` to `.env` and fill in your values. `.env` is gitignored and never written by the harness.

```bash
cp .env.example .env
# then edit .env — add NASA_API_KEY, OBSERVER_LAT, OBSERVER_LON
```

### No sandbox / test mode on NASA APIs

NASA Open APIs have no separate sandbox endpoint. Safety in this harness comes from two sources:

1. **All endpoints are read-only GET requests.** There is nothing to accidentally mutate.
2. **`DEMO_KEY` as a rate-limited default.** If you have not registered a key, the harness uses `DEMO_KEY` and enforces a soft session cap of 25 requests, warning you to register before running batch scenarios.

To register a free NASA API key (takes about 5 minutes, delivers by email):
[https://api.nasa.gov/](https://api.nasa.gov/)

### CelesTrak TLE data

TLE sets are fetched from `https://celestrak.org/NORAD/elements/gp.php` with no authentication. The harness caches downloaded TLE files in `.harness/cache/tle/` and will not re-download the same group more than once per 2 hours, respecting CelesTrak's rate policy. TLEs older than 48 hours trigger a freshness warning because SGP4 accuracy degrades with TLE age.

---

## Usage

### Slash command

```
/space-brief [--date YYYY-MM-DD] [--lat LAT] [--lon LON] [--satellite GROUP] [--category EONET_CATEGORY] [--min-elev DEGREES]
```

**Parameters**:
- `--date` — APOD date (default: today). Range mode: `--start-date` / `--end-date`.
- `--lat`, `--lon` — override observer location for pass prediction.
- `--satellite` — CelesTrak group name: `STATIONS`, `STARLINK`, `ACTIVE`, `AMATEUR`, etc. (default: `STATIONS`).
- `--category` — EONET event category: `wildfires`, `severeStorms`, `volcanoes`, `seaLakeIce`, `landslides`, `floods`, `dustHaze`, `manmade`, `snow` (default: all open events).
- `--min-elev` — minimum elevation in degrees for a pass to be reported (default: `10`).

### Representative prompts

```
Show me today's Astronomy Picture of the Day and any active wildfires near California.

Predict the next visible ISS pass over London (51.5° N, 0.1° W) in the next 24 hours.

Give me a space brief for 2026-07-04 — APOD from that date plus any open EONET severe storms.

Which Starlink satellites will be visible above 20° elevation from my location tonight?
```

### Example output (illustrative)

```
SPACE BRIEF — 2026-06-17

APOD: "Webb Reveals Galaxy Cluster SMACS 0723"
  URL: https://apod.nasa.gov/apod/image/2206/Webb_smacs0723_4096.jpg
  Media type: image | Copyright: NASA / ESA / CSA / STScI

EONET OPEN EVENTS (wildfires, last 7 days): 3 events
  - "California Complex Fire" — lat 38.5° N lon 122.1° W — magnitude 12,450 acres
  - ...

NEXT ISS PASS (observer: 37.77° N 122.42° W, min elev 10°):
  AOS: 2026-06-17T03:14:22Z  Az 312°
  MAX: 2026-06-17T03:17:38Z  El 67°  Az 180°
  LOS: 2026-06-17T03:20:54Z  Az  48°

VERIFICATION: pass elevation 67° > threshold 10° [PASS] | APOD date match [PASS] | EONET status=open [PASS]
```

---

## Safety

- **All NASA API endpoints are read-only.** No mutation, no billing, no side effects.
- **`satellite.js` is pure local computation** — no network calls, no file I/O beyond the TLE cache.
- **Secrets via environment only.** `NASA_API_KEY` is never written to scaffolded files. `.env` is gitignored.
- **Rate-limit guard.** The executor checks `X-RateLimit-Remaining` after each NASA call and backs off when the value falls below 10. When `DEMO_KEY` is active, a soft cap of 25 requests per session applies.
- **TLE cache.** The harness will not re-download a CelesTrak group more than once per 2 hours. A staleness warning fires if the cached TLE epoch exceeds 48 hours.
- **MCP default-deny.** Only `fetch`, `read_file`, `write_file` (restricted to cache/log paths), and read-only `bash` are granted. All other tools are denied, and every invocation is appended to `.harness/audit.jsonl`.

**Not for production aerospace use.** This harness is illustrative only. Orbital data carries inherent uncertainty and must not be used for flight planning, launch operations, collision avoidance, spectrum management, or regulatory compliance without authoritative sources and domain-certified software.

---

## How it works

### Agents

Three agents run in a hierarchical topology:

**`space-planner`** (Frontier tier — Sonnet/Opus)
Interprets the user's intent from the slash command or natural-language prompt. Resolves the date, observer location, satellite group, and EONET category. Decomposes the request into three parallel fetch sub-tasks. Writes the final mission brief using raw results from the executor.

**`space-executor`** (Cheap tier — Haiku)
Executes all HTTP fetches concurrently: APOD from `api.nasa.gov`, EONET from `eonet.gsfc.nasa.gov`, and TLE sets from CelesTrak. Runs the `satellite.js` propagation loop over the requested time window. Assembles structured JSON results for the planner and verifier.

**`space-verifier`** (Cheap tier — Haiku)
Re-reads raw API responses from the executor's output. Checks: APOD `date` field matches the requested date; EONET events all have `status: "open"`; computed peak elevation exceeds the configured threshold; TLE epoch is within 48 hours. Emits a pass/fail verification report. The planner will not present the brief as done if any check fails.

### Routing tiers

| Tier | Model | Used for |
|---|---|---|
| 1 (WASM/local) | No LLM | TLE line parsing (`twoline2satrec`) — pure JS, sub-millisecond |
| 2 (cheap) | Haiku | HTTP fetches, JSON extraction, SGP4 propagation loop, field-level verification |
| 3 (frontier) | Sonnet / Opus | Mission brief composition, EONET event narration, intent disambiguation |

### MCP policy (granted tools)

The scaffolded `.harness/mcp-policy.json` uses default-deny and grants:

- `fetch` — outbound GET requests to `api.nasa.gov`, `eonet.gsfc.nasa.gov`, and `celestrak.org` only
- `read_file` — TLE cache files in `.harness/cache/tle/`
- `write_file` — TLE cache in `.harness/cache/tle/` and pass log in `.harness/logs/passes.jsonl`
- `bash` — read-only (`node --check` syntax validation only)

All other tools are denied. Every grant invocation is appended to `.harness/audit.jsonl`.

### Multi-host scaffold

Pass `--host <id>` to emit the config for a specific host, or `--host all` to emit all nine. Host wiring delegates to the `metaharness` CLI and the relevant `@metaharness/host-<id>` adapter, so host-specific config stays single-sourced.

Supported hosts: `claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`.

---

## Links

- **NASA Open APIs** — [https://api.nasa.gov/](https://api.nasa.gov/)
- **NASA APOD API source** — [https://github.com/nasa/apod-api](https://github.com/nasa/apod-api)
- **EONET v3 documentation** — [https://eonet.gsfc.nasa.gov/docs/v3](https://eonet.gsfc.nasa.gov/docs/v3)
- **satellite.js (npm)** — [https://www.npmjs.com/package/satellite.js](https://www.npmjs.com/package/satellite.js)
- **satellite.js (GitHub)** — [https://github.com/shashwatak/satellite-js](https://github.com/shashwatak/satellite-js)
- **CelesTrak GP data formats** — [https://celestrak.org/NORAD/documentation/gp-data-formats.php](https://celestrak.org/NORAD/documentation/gp-data-formats.php)
- **NASA API rate limits** — [https://api.nasa.gov/assets/html/authentication.html](https://api.nasa.gov/assets/html/authentication.html)
- **ADR-067** (this design) — [docs/adrs/ADR-067-example-nasa.md](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-067-example-nasa.md)
- **ADR-051** (examples program) — [docs/adrs/ADR-051-third-party-sdk-showcase-examples.md](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
- **MetaHarness generator** — [https://github.com/ruvnet/agent-harness-generator](https://github.com/ruvnet/agent-harness-generator)
