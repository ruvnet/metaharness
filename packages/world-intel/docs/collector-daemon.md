# Explicit collector lifecycle

`src/collector-daemon.ts` ports the lifecycle of pinned upstream `collector.py` without import-time setup, `.env` discovery, implicit model loading or background startup. It is a library component; starting it must be a separate explicit action. No daemon was launched by implementation or fixture tests.

## Contracts

`createCollectorDaemon` requires a local `dataDirectory`, `allowWrites:true`, and an `open` resource factory. Construction is inert. `run()` opens resources once, collects serial cycles, drains pending writes when supplied, and closes resources on success, stop or failure. A controller runs once only. The factory must validate/create the explicitly chosen directory and return real collection, cache-eviction and cleanup functions. It must clean partially constructed resources if opening fails before it returns.

The collection callback receives resolved source names, the 45-second default per-source budget and the 240-second AOI override. Its normal implementation is `collectOnce` with explicitly configured source callbacks, vector and history stores, or the governed configured registry's `intel_collect`. Collection executes with the expressly granted write capability, scoped to that asynchronous cycle. A callback that ignores the source filter or substitutes fabricated outcomes violates this contract.

Use `stop()`, an injected AbortSignal, or an explicitly supplied SIGINT/SIGTERM adapter to stop. No process-signal handlers are installed unless the caller supplies the adapter. Stops interrupt the waiting interval but allow an in-flight cycle to finish and persist its outcomes. Per-source deadlines remain the responsibility of `collectOnce`, matching upstream graceful cycle shutdown.

## Pinned semantics

- The exact 61-source roster and source arguments live in `data/public/collector.json`. Domain groups and timeout overrides are preserved in the lifecycle module.
- `markets,migration` expands domain groups and deduplicates names. Unknown names survive filtering, so a wholly unknown selection runs zero sources, as upstream does; it does not silently select all sources.
- Default cadence is 300 seconds **after cycle completion**. A 40-second cycle therefore starts its successor about 340 seconds later. Cycles do not overlap.
- Cache eviction occurs after every twelfth attempted cycle, including collection failures. This is not a fixed hourly wall-clock timer when cadence or cycle duration changes.
- A collection exception is recorded and later cycles continue. An eviction failure terminates and closes resources, as in upstream's placement outside the cycle exception handler.
- History retention runs within `HistoryStore.recordCycle` on each collected cycle. The lifecycle does not introduce a second hourly prune scheduler. Outcome transactions, stale-serve recording, retention windows and write-failure records remain storage/collector responsibilities.
- The upstream roster comment says analysis runs after raw sources, but its actual `asyncio.gather` dispatch is concurrent. This lifecycle does not invent a two-phase source schedule.
- Optional queue drain completes before resource close. Native synchronous SQLite vector writes have no queue to drain.

## Intentional differences and remaining evidence

No dotenv/logging setup, default data directory, listener, model download or automatic daemon launch is reproduced. The caller must explicitly configure local storage and authorize writes. Intervals are bounded to whole seconds in1..86400 rather than allowing busy-loop or invalid negative intervals. `maxCycles` is an explicit optional bounded-run/testing convenience.

Tests inject clocks, wait functions, source outcomes and resource handles. They verify cadence, exact roster/group behavior, single-flight cycles, twelfth-cycle eviction, graceful signals, cleanup and write-capability isolation. They do not prove long-running real-provider uptime, full shared fetcher/cache/circuit-breaker equivalence, OS service installation, or storage behavior that an injected factory does not actually implement. History operational-error retry policy and stale-serve capture must be verified in the one-shot collector/storage integration independently.

## Explicit collector command

`world-intel-collect --data-dir ./world-intel-data --allow-writes --once --sources natural`

Omit `--once` for completion-relative recurring collection; `--interval 300` sets seconds. `--sources markets,migration` expands domain groups, while unknown names collect nothing. A comma-only selection remains empty rather than falling back to every source. `--embedding-model-dir DIRECTORY` explicitly enables verified local BGE assets, with no download. Without an embedding model, vector persistence failures are reported; collection/history do not claim successful vector indexing.

The separate `collector-cli.ts` entrypoint installs SIGINT/SIGTERM handlers only when executed as a command. Its imports and parser do not open storage, fetch providers, load models or install handlers. It opens the configured runtime explicitly, dispatches `intel_collect` under the lifecycle write capability, evicts that runtime's actual cache every twelfth cycle, and disposes model/store resources. Unit tests inject all runtime dependencies and do not run live collection.

The one-shot collector now records per-source asynchronous stale-fetch provenance even when the adapter omits `_stale`, excludes such results from new vector observations, and supplies that provenance to history. History writes retry once for typed SQLite operational errors after transaction rollback, not generic exceptions or constraint violations. Unlike upstream's fresh HistoryStore per attempt, the native implementation reuses the rolled-back configured connection. Cross-process lock behavior still needs integration evidence beyond injected retry fixtures.
