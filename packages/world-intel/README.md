# @metaharness/world-intel

Native TypeScript World Intel compatibility port with MetaHarness governance and a reproducible AssemblyScript WASM geospatial kernel. No Python runtime. **100% parity is the goal, not the current result.**

Pinned upstream: `marc-shade/world-intel-mcp` `fdebf9a8de6e00ed688053dd647cafedc179708b` (0.11.0, MIT). The checked-in inventory preserves all 160 tool schemas, 29 prompts, three resources, source hashes and attribution. Inventory does not imply implementation. `tools/list` advertises only handlers actually wired into the native registry; missing tools are not simulated.

## Build and run

Node >=22.13 is required for durable SQLite features. From this directory:

```sh
npm ci --workspaces=false --ignore-scripts
npm run build:wasm
npm run build
npm test
npm run audit:parity
npm run audit:complete # intentionally fails until all parity requirements are met
node dist/cli.js       # native MCP stdio, no HTTP listener
npm run smoke:live     # explicit live USGS check of the original governed client
```

The isolated package lock and root workspace lock are checked in. The root ordered build runs this after `@metaharness/harness`. The package remains private and the PR is a draft.

## Implemented surfaces

The native registry covers static geospatial datasets; markets/liquidity/finance; hazards and cyclone forecast parsing; public technology sources; news and NLP; elections; cyber/humanitarian/aircraft metadata; and conflict adapters. The exact implemented set is computed by `audit:parity`, not a hard-coded marketing count. Four history tools can additionally be registered with an explicitly supplied `HistoryStore`. The server exposes all 29 prompt templates and three resource interfaces, but some templates reference tools still missing from this port.

Each tool call passes through the actual MetaHarness policy and verifier, with hash-chained receipts in MCP `_meta.governance`. Normal tool content retains upstream-shaped results. The verifier rejects explicit source errors/degraded/stale results, including nested provider flags; it is **not independent factual corroboration**, full schema equivalence or a guarantee that unmarked source data is fresh. Unsupported tools remain absent.

The original four-tool `./mcp` module and typed `WorldIntelClient` are retained for compatibility with the initial slice. The CLI uses the new pinned-schema registry. They are separate interfaces; the original camelCase API is not upstream parity.

## TS + WASM division

TypeScript implements adapters, schemas, parsers, storage, MCP and orchestration. AssemblyScript compiles the spherical distance and antimeridian-aware bounding-box primitives to real WASM with no host imports or network. The TS fallback is explicit and tested; no performance claim is made. Static upstream dataset filters intentionally retain upstream filtering semantics rather than inventing a WASM path.

## Boundaries and gaps

- Fixed provider endpoints, bounded payloads/timeouts and no arbitrary-URL tool. Data is untrusted, never instructions.
- Optional keys, ACLED authorization and SEC contact identity must be explicitly supplied by the caller. No environment-secret discovery. No provider accounts, purchases or API permissions are created.
- Mutation-capable calls (including keyword baseline updates) are denied unless the server is explicitly configured with `allowWrites:true`.
- Runtime construction makes no network calls or persistent writes. History and persistent keyword baselines require explicit storage construction.
- Safety improvements are disclosed as parity differences: stricter input/network limits and explicit degraded errors instead of upstream silent-empty fallback. The upstream keyword-spike `word`/`keyword` bug is fixed, not reproduced.
- Shared persistent cache/circuit-breaker behavior, several optional provider branches, dashboard, remote transport, vector analytics and many composite/geofence tools still need implementation or equivalence evidence. See `data/parity.json` and `docs/parity.md`.
- The compatibility military-flight adapter preserves upstream mislabeled ADSB feet/knots fields named `altitude_m`/`velocity_ms`; do not interpret these as SI units without a source-specific conversion. This defect remains an explicit correctness gap.
- Fixture tests are not live-provider coverage. No full live sweep or 100% equivalence claim is made.
- This is stdio only. No production deployment, ruOS/ChatGPT configuration change or public listener is performed by this PR.

See `THIRD_PARTY_NOTICES.md` for the full upstream MIT notice. Provider terms remain applicable; public API access does not imply unrestricted reuse.
