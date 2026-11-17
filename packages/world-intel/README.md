# @metaharness/world-intel

TypeScript-first public intelligence for MetaHarness, with a real AssemblyScript-generated WebAssembly geospatial kernel. No Python runtime, model, key, listener or paid API is required.

**This is an initial implementation, not a drop-in port of upstream's 160 tools.** It currently implements USGS earthquakes, US NWS active weather alerts, four annual World Bank indicators, local capability status, and two geospatial primitives. Upstream dashboard, history, prompts/resources, financial/conflict/aircraft tools, persistent geofences and remote ChatGPT transport are not implemented.

## Build and run

Node 22+. From this directory:

```sh
npm ci --workspaces=false --ignore-scripts
npm run build:wasm
npm run build
npm test
npm run smoke:live # explicit live USGS request
node dist/cli.js   # native MCP stdio, stdout reserved for protocol
```

The package-local lock allows isolated validation. The repository root lock also registers the workspace; its ordered build runs this after `@metaharness/harness`. Use the root installation for local sibling-package development. The package remains private until review.

MCP tools: `intel_earthquakes`, `intel_weather_alerts`, `intel_indicator`, `intel_status`. Every data call runs through the actual MetaHarness policy gate and provenance/freshness verifier and includes hash-chained governance receipts. Verification checks structure and freshness, **not independent factual corroboration**. Zero API spend means no paid provider call, not zero infrastructure cost. No claim of useful self-learning or autonomous optimization.

## TS + WASM division

TypeScript owns transport, schemas, API adapters, caching, MCP and MetaHarness orchestration. WASM handles deterministic spherical distance and antimeridian-aware bounding-box checks. AssemblyScript source is compiled reproducibly, no Rust/Python build needed. WASM has no host imports or network capabilities. A TS fallback is explicit and parity-tested, not silently substituted. No speedup claim is made.

```ts
import { readFile } from 'node:fs/promises';
import { WorldIntelClient, runIntelObservation, loadGeoWasm } from './dist/index.js';
const run = await runIntelObservation(() => new WorldIntelClient().earthquakes({limit: 3}));
const geo = await loadGeoWasm(await readFile('./wasm/geo.wasm'));
console.log(run.success, run.receiptsValid, geo.backend);
```

## Trust and data semantics

- Fixed HTTPS origins and paths; no arbitrary URL tool, credentials or redirects. Arguments are bounded, requests timeout, bodies and cache size are limited.
- Provider output is untrusted data, never instructions. Observation time and retrieval time are separate; annual economic indicators are not live market measurements.
- Cache entries are cloned to prevent accidental mutation. Stale fallback must be explicit and bounded. MetaHarness rejects stale data for promotion to a current brief, even when directly requested.
- No alerts is not proof of safety; NWS coverage is US-only. Source errors are surfaced, not converted into empty successful observations.
- Geospatial distance is spherical straight-line distance, not road distance, legal boundaries, surveillance or billable mileage.
- This is stdio only. Do not expose it via an unauthenticated public bridge. Existing ruOS authentication can mediate a future install; no production configuration is changed by this PR.

## Porting next

Each new source needs a schema, fixed endpoint, fixtures, rate/response bounds, timestamps and source citations, negative tests and a separately recorded live check. Keep unsupported tools absent instead of returning fabricated empty data. Add persistence, authenticated remote MCP, operational sources and higher-level research only in separately reviewed slices. See `docs/adrs/ADR-324-world-intel-ts-wasm.md`.

See `THIRD_PARTY_NOTICES.md` for the MIT upstream attribution. Public API terms and availability remain the providers' responsibility; no blanket unrestricted-use assertion is made.
