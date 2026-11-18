# @metaharness/world-intel

Native TypeScript World Intel compatibility port with MetaHarness governance, durable SQLite options and real AssemblyScript/ONNX WASM paths. No Python runtime. **All 160 upstream tools are wired when storage is configured; exhaustive behavioral parity is not yet certified.**

Pinned upstream: `marc-shade/world-intel-mcp` `fdebf9a8de6e00ed688053dd647cafedc179708b` (0.11.0, MIT). The inventory preserves 160 exact tool schemas, 29 prompts, three resources, 259 source hashes and attribution. Registration and fixture coverage are not proof of live availability or complete semantic equivalence.

## Build and check

Node >=22.13 is required for SQLite. From this directory:

```sh
npm ci --workspaces=false --ignore-scripts
npm run build:wasm
npm run build
npm test
npm run audit:parity
node --experimental-strip-types scripts/parity-audit.ts --configured
npm run audit:complete # intentionally fails until all parity evidence is established
```

The isolated package and root workspace locks are checked in. The root ordered build runs this package after `@metaharness/harness`. The package is private; no npm publication or production deployment is implied.

## Run the MCP server

```sh
# Default: 145 tools, no durable storage, mutations denied.
node dist/cli.js

# Explicit local storage: all 160 tools registered, mutations still denied.
node dist/cli.js --data-dir ./world-intel-data

# Explicitly authorize mutation-capable tools within this server instance.
node dist/cli.js --data-dir ./world-intel-data --allow-writes

# Also enable semantic embeddings using already-present local model assets.
node dist/cli.js --data-dir ./world-intel-data --allow-writes \
  --embedding-model-dir ./models/bge-small-en-v1.5
```

These are stdio servers, not HTTP listeners. `--data-dir` creates SQLite stores for history, vectors, AOIs, aircraft cohorts and temporal baselines, with a local report-output directory used when reports are generated. It does not start a collector or fetch data. `--allow-writes` permits explicit collection/backfill, AOI changes, baseline updates and report writes. Permission follows nested dependency calls, not just the top-level tool name.

The 15 storage-dependent tools comprise seven vector query/statistics tools, the collector, four capture/history tools, and three history analysis/backfill tools. Empty stores are empty: a tool name does not imply a populated archive or enough baseline observations.

Semantic search, similarity, cross-correlation and vector ingestion additionally need a compatible embedding provider. The optional local adapter uses `@huggingface/transformers` tokenization and `onnxruntime-web` WASM inference. The supplied directory must contain `config.json`, `tokenizer.json`, `tokenizer_config.json` and `onnx/model.onnx` for BGE-small-en-v1.5. There are **no automatic model downloads**. The adapter rejects unknown model/tokenizer hashes against pinned official manifests. Six official FastEmbed reference fixtures match token IDs and rankings with vector tolerance0.0003, not bit-identical or exhaustive equivalence; see LOCAL_EMBEDDINGS.md. Library callers may instead supply an explicit embedding provider.

Optional provider credentials, ACLED authorization, SEC contact User-Agent and other integrations are supplied through the library's registry/runtime options. The CLI does not discover environment secrets or expose credential flags. Storage/model configuration alone does not enable every keyed provider.

## Implemented surfaces and governance

Native handlers cover geospatial datasets; markets/liquidity/finance; hazards and cyclone forecasts; technology/news; conflict, military and aviation; migration and border-flow datasets; infrastructure; intelligence composites; AOIs/geofences; local vector/history analytics; collection; and reports. All 29 prompt templates and three resource interfaces are present. The default registry omits storage-dependent tools that some prompts reference; configured mode exposes their schemas, subject to the runtime requirements above.

Every MCP call passes through the actual MetaHarness policy and verifier, with hash-chained receipts in `_meta.governance`. Results retain upstream-shaped content where supported. The verifier rejects explicit errors, stale/degraded data and nested failure flags. It is **not factual corroboration**, exhaustive schema/behavior equivalence, or proof that unmarked provider data is fresh. Collection also refuses to index known stale/degraded results as healthy vector observations.

The original four-tool `./mcp` module and typed `WorldIntelClient` remain separate compatibility interfaces. Their camelCase API is not the upstream-compatible registry used by the CLI.

## TS + WASM division

TypeScript implements adapters, schemas, parsing, SQLite storage, MCP and orchestration. AssemblyScript compiles spherical distance and antimeridian-aware bounding-box primitives to WASM with no host imports or network. Local semantic inference optionally uses ONNX WASM. Explicit TS geospatial fallbacks and static upstream filter semantics remain tested; no blanket WASM acceleration or performance claim is made.

## Remaining boundaries

- Provider endpoints are restricted; payloads, deadlines, archives and parser expansion are bounded. Retrieved data is never treated as instructions.
- The default registry makes no network calls or persistent writes during construction. Explicit storage construction writes local database schemas; explicit model configuration loads local assets.
- Safety changes are disclosed as parity differences: stricter input/network limits, explicit missing-data errors, transitive write permissions and refusal to label unknown risk as low risk. Known producer/consumer field mismatches are repaired with disclosure rather than hidden zeroes.
- Shared cache/circuit-breaker behavior, optional provider branches, every malformed/error path, all embedding inputs and full live coverage still need equivalence evidence. The separate dashboard is an explicit-start HTTP surface, not a deployed service or remote MCP transport.
- Military compatibility fields preserve upstream ADSB feet/knots under misleading `altitude_m`/`velocity_ms` labels. Do not interpret those source values as SI without conversion.
- Native HTML/PDF report support is not a claim of pixel-identical upstream rendering. Durable file output requires configured storage and write permission.
- No ruOS/ChatGPT installation, public listener, production deployment or merge is performed by running the validation suite.

See [validation checkpoints](VALIDATION.md), [parity evidence](docs/parity.md), `data/parity.json` and `THIRD_PARTY_NOTICES.md`. Public API access does not remove provider terms or attribution obligations.

## Explicit operational entrypoints

```sh
# Start a write-authorized collector explicitly; --once limits it to one cycle.
node dist/collector-cli.js --data-dir ./world-intel-data --allow-writes --once

# Start the dashboard explicitly on loopback. No daemon starts with it.
node dist/dashboard-main.js --data-dir ./world-intel-data --host 127.0.0.1 --port 8501
```

The collector defaults to serial cycles with a 300-second wait after each completed cycle when `--once` is absent. Optional local embedding assets are configured with `--embedding-model-dir`. Without them, history collection remains available but vector ingestion reports its missing provider rather than generating substitute embeddings.

The dashboard ports the pinned UI/routes and progressive SSE using explicit configured stores. Loopback Host/Origin checks are intentional hardening. Starting a remote binding requires an explicit `--allow-remote`; this is not authentication or a production deployment recipe. No listener or background collector was started during development tests. See `docs/collector-daemon.md` and dashboard evidence for limitations.

## Upstream command-line surface

`node dist/intel-cli-main.js --help` lists all 87 pinned executable commands, including nested AOI/history/backfill commands. The `intel-ts` bin uses the same dispatcher. Commands preserve parsed defaults and aliases and run through MetaHarness governance; `--receipts` prints governance evidence to stderr. State-changing commands require explicit `--allow-writes` and configured storage. JSON output replaces upstream Rich tables; no terminal-layout identity is claimed.
