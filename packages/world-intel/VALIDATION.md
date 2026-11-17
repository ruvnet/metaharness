# Validation checkpoints

These are dated observations, not a permanently current test count or a claim of complete parity. Re-run the package checks and inspect CI for the commit being evaluated.

## 2026-11-17: native compatibility expansion

- Offline SDK inspection observed **145 default tools** and **160 configured tools**, each advertised with the exact pinned upstream input schema. All 29 prompts and three resources were listed.
- The configured audit constructed isolated temporary file-backed HistoryStore and NativeVectorStore instances, then closed and removed them. It did not load embeddings, supply credentials, invoke providers or populate history.
- Inventory integrity passed for the pinned 160-tool/29-prompt/3-resource snapshot, handler-source hashes, full MIT notice and all 259 captured upstream source hashes.
- Local full-suite checkpoint: **584 tests across 62 files passed**, observed at 23:26 UTC. Other workers continued adding regression cases afterward; this is not the final test count.
- `npm run build` passed at the preceding integration checkpoint. Targeted later tests include collector stale/degraded rejection, transitive write-policy isolation, migration/border publisher fixtures and bounded ODS parsing. Rebuild after subsequent edits.
- `--require-complete` **correctly exits nonzero**. Exact schema/name coverage is complete in configured mode; exhaustive output/error/state/provider equivalence remains unverified.
- Source and selected fixture evidence is linked for every registered tool in `data/parity.json`. `fixture_verified` means selected fixtures exist and have been exercised, not that every argument branch or live provider has been certified.

```sh
npm run build:wasm
npm run build
npm run lint
npm test
node --experimental-strip-types scripts/parity-audit.ts
node --experimental-strip-types scripts/parity-audit.ts --configured
node --experimental-strip-types scripts/parity-audit.ts --configured --require-complete
# Optional full pinned-source integrity comparison:
node --experimental-strip-types scripts/parity-audit.ts \
  --configured --upstream=/path/to/pinned/world-intel-mcp
```

`--configured` is an offline schema audit, not a live readiness check. The runtime's `--data-dir` mode additionally wires durable AOI/cohort/baseline stores and local report output; write-capable calls still require `--allow-writes`.

## Storage, model and permission evidence

- SQLite fixtures exercise captures, observations, revisions, replay, time-series analysis, backfill, vector operations, AOIs and cohort/baseline state. An empty new store contains no previous observations, and collection does not start automatically.
- Semantic operations and vector ingestion require explicit embedding configuration. Local-only BGE tokenization/CLS pooling/L2 normalization and no-download behavior have injected-runtime tests. Real model-weight identity and full upstream embedding-output equivalence were not established by those tests.
- Read-only MCP requests cannot acquire mutation capability through a nested registry call. AsyncLocalStorage capability tests cover nested denial and concurrent-request isolation.
- Collector vector ingestion excludes top-level and nested unaccepted provider state; failure outcomes can still be retained in capture history as failure evidence.
- Strategic posture tests preserve the original complete-input weighted formula while showing unknown domains explicitly. Producer-field repairs and unavailable-domain treatment intentionally differ from upstream latent zero-risk bugs.
- CBP/UK border fixtures reproduce captured publisher counts, use native CSV and bounded streaming ODS/ZIP parsing, and test path/port/credential rejection, CRC, XML entities, repeat expansion, dates, missing figures, stale fallback and cache isolation.

## Live checks, limited scope

Earlier explicit hazard smoke calls returned USGS: three events; NWS: one alert; EONET: one event; NHC: a valid empty active-storm list, without explicit degraded/error flags. These were individual source calls, not an all-provider sweep. Forecast tracks/cones and border data were fixture-tested; no live coverage of those branches is inferred.

The original governed USGS client also returned fresh provenance and valid MetaHarness receipts. CLI `--live-smoke` exercises that original client, not all 160 native tools or a desktop/ChatGPT installation.

## Reproducible WASM and initial slice

- Initial environment: Node 24.22.1, TypeScript 5.9.3, AssemblyScript 0.27.31, Vitest 4.1.12.
- Geospatial WASM artifact: 9,505 bytes; SHA-256 `b14b32f49a2aae2d225e9ffef62fae2ca48cf8235870e50ac9f9d0726ccf5570`, rechecked during documentation refresh.
- The initial four-tool slice passed 28 tests in five files. That historical result is superseded by the expansion checkpoint, not added to its count.
- Independent review fixed rejection of missing/null provenance, wrong source/origin, old/future timestamps and invalid cache ages. Current-brief promotion requires a five-minute retrieval-age ceiling.

## CI and publication boundary

Scoped world-intel and security CI checks passed on the earlier `d21` revision as reported by the publication coordinator. Broader checks at that checkpoint still had a package-version expectation mismatch and macOS `/var` symlink fixture failures; fixes were in progress. Those results are not an assertion that the current revision's monorepo CI is green. Check the exact remote commit and job results independently.

Earlier isolated production dependency audits reported zero vulnerabilities, while a root-workspace audit had three moderate entries in pre-existing HTTP-related dependencies. Dependencies and locks have since evolved; rerun the relevant audits instead of treating that historical result as current. Stdio does not instantiate an HTTP server, but that is not a blanket security guarantee.

No npm publication, production deployment, ruOS/ChatGPT configuration change, full monorepo test pass, exact behavioral parity, performance gain or autonomous-learning improvement is claimed by this document.
