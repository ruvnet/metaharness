# Initial validation, 2026-11-17

- Node 24.22.1, TypeScript 5.9.3, AssemblyScript 0.27.31, Vitest 4.1.12.
- Rebuilt real WASM: 9,505 bytes; SHA-256 b14b32f49a2aae2d225e9ffef62fae2ca48cf8235870e50ac9f9d0726ccf5570.
- `npm run build`, `npm run lint`, `npm test`: passed, 28 tests in five files. Repeated after linking the locally compiled sibling harness, also passed.
- Real SDK initialize/list/call exchanges tested over its in-memory transport. CLI smoke is a separate live source call, not an end-to-end desktop or ChatGPT installation.
- Live USGS request returned three events with source URL, fresh retrieval timestamp and valid MetaHarness receipts. NWS and World Bank have fixture validation only.
- `npm audit --workspaces=false --omit=dev`: zero vulnerabilities reported for the isolated package lock. A root-workspace audit reports three moderate dependency entries in existing HTTP-related dependencies; root-wide remediation is outside this patch. Stdio does not instantiate those HTTP routes, but that is not a blanket safety assertion.
- `npm pack --dry-run`: includes compiled TS and bundled WASM/source. Not published.
- No monorepo-wide build/test result, hosted transport test, 160-tool parity, performance gain, autonomous-learning improvement or production deployment is claimed.
- Scoped GitHub workflow added; its remote result must be checked independently.

Independent review found and fixed a provenance-validation gap: missing/null provenance, wrong source/origin, old/future timestamps and invalid cache ages now fail closed with verified rejection receipts. Current-brief promotion enforces a five-minute retrieval-age ceiling.

## Native compatibility expansion checkpoint

The new default CLI is the pinned-schema native registry, not the original four-tool adapter. The offline parity audit checks the exact160-tool/29-prompt/3-resource snapshot,259 pinned source hashes, actual MCP registration and schemas, and per-tool evidence. The complete gate intentionally fails: unimplemented and partially verified behavior remains. See machine-readable `data/parity.json` and run `npm run audit:parity` for the authoritative current counts.

Additional checks: native per-domain fixtures and real SDK in-memory protocol tests; MetaHarness success/rejection receipts including nested stale/degraded flags and write-policy denial; bounded forecast ZIP/CRC/expansion/issuance parsing; optional SQLite persistence/revision tests; fixed-origin custom-port rejection; reproducible WASM unchanged. Production dependency audit returned zero vulnerabilities. This is scoped package evidence, not a full monorepo CI claim.

Live checks of the new hazard adapters: USGS3 events, NWS1 alert, EONET1 event, NHC valid empty active-storm list. These four source calls succeeded without explicit degraded/error flags. Forecast tracks/cones were fixture-tested, not live-tested; no all-provider sweep claimed. No deployment or merge performed.
