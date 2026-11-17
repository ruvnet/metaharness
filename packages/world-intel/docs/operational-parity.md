# Operational parity beyond tool names

Pinned reference: marc-shade/world-intel-mcp commit
`fdebf9a8de6e00ed688053dd647cafedc179708b`.
The static inventory in `data/dashboard/surface.json` was extracted from Python
syntax trees, without importing or executing upstream application code. It records
15 dashboard route registrations, 14 unique paths, 47 progressive sources, and
91 CLI decorator registrations (87 executable commands and four group registrations,
including the root group). Tool-count completeness alone does not prove these surfaces.

## Dashboard adapter implemented

- `dashboard.ts`: all pinned route paths and GET/POST/OPTIONS distinctions, progressive
  SSE completion-order payloads and final metadata, conflict fallback (including explicit
  null to clear a recovered fallback), source deadlines, overview and static datasets.
- Research routes retain 400 validation errors, 503 provider errors, 504 budget expiry,
  liquidity methodology even on failure, and no research CORS wildcard.
- Migration preserves capital-coordinate anchors, unplotted rows and primary versus
  secondary-provider outage distinctions.
- AOI map data reads stored snapshots, not live sweeps; a never-swept AOI has null counts.
- Vector analytics, search, preflight, collection-health statuses, and health are wired.
- `/api/report/pdf` deliberately returns upstream's HTTP 410 removal response.
  It must not be confused with the separate MCP report-generation tool.
- Pinned dashboard HTML is retained with MIT attribution. It uses external Leaflet,
  DOMPurify, Google Fonts and Carto map assets, as upstream does.
- `dashboard-http.ts` provides an unbound server constructor and explicit startup;
  `dashboard-main.ts` is the runnable, explicit-data-directory executable.
  It connects native handlers, cache/breaker health, AOI/history/vector stores and
  World Bank coordinates. Optional embedding is loaded only from an explicit local path.
- Shutdown cancels HTTP streams/connections and disposes owned runtime/model resources.

## Intentional security differences

- Bind defaults to loopback. Remote binding requires explicit `--allow-remote`.
- HTTP rejects unexpected Host values on loopback and foreign Origin by default.
  An embedding caller can explicitly allow exact origins, never a wildcard.
  Upstream's public-response CORS wildcard is stripped at the HTTP boundary;
  approved-origin responses echo only that origin.
- Request bodies, headers and request/header deadlines are bounded; vector bounds
  reject non-finite/negative values instead of inheriting permissive coercion.
- HTML escaping includes quotes. Leaflet tooltip/popup string sinks are sanitized,
  including callback/update paths; external URLs are restricted to HTTP(S).
  Missing DOMPurify fails closed to escaped text.
- No implicit data directory, cloud credentials, model downloads or listener startup
  occur when importing reusable modules.
- JS error class names differ from Python exception names. They remain errors, never
  fabricated successful payloads.

## Validation completed

`tests/dashboard.test.ts` uses in-memory Request/Response objects, mocked providers,
a mocked HTTP request event (no bound socket), fake timers and a sandboxed evaluation of
the HTML escaping/sanitizer configuration. It verifies 20 cases covering route inventory,
source aliases, static data, 410, progressive order, fallback clearing, timeouts, cancellation,
HEAD, research errors, AOI absence/outage, migration coordinate gaps, vector failures,
collection status, explicit binding, Origin/CORS and hostile titles/protocols.
TypeScript compilation passes.

No network listener or deployment was started during implementation. No browser was
opened, external asset downloaded, or live-provider end-to-end dashboard run performed.
The HTML regression tests validate escaping and sanitizer invocation/configuration;
they do not claim a real-DOM DOMPurify/browser integration audit.

## Additional CLI validation

Dashboard and CLI tests together: 113 passed. TypeScript compilation passes. Entry guards
resolve executable symlinks, allowing npm bin invocation without starting on import.
CLI report outputs use exclusive creation; startup/signal failure cleanup attempts every
owned resource and handles asynchronous signal errors.

## Remaining verification and non-dashboard gaps

1. **Live HTTP/browser validation remains unperformed.** Test actual sockets,
   disconnect/backpressure, signal shutdown, mobile rendering, map drawers, each external
   asset availability, hostile content in a real DOM, and all 47 live providers.
2. **Provider cancellation is cooperative.** Injected dashboard source factories receive
   an AbortSignal. Generic MCP-handler adapters have no signal parameter, so a deadline
   stops waiting but cannot guarantee cancellation of their underlying provider requests.
3. **Shell command dispatch is now implemented, human rendering is not identical.**
   `intel-cli.ts` / `intel-cli-main.ts` and `data/cli-commands.json` cover all 87 executable
   commands: 70 root, nine AOI, six history, two backfill. The generated manifest preserves
   pinned option/argument names, aliases, defaults, choices, repeated values and variadic
   arguments. Explicit transforms handle coordinates, symbol/offset lists, report sections
   and history parameter names. All commands execute through actual MetaHarness policy and
   receipt verification; `--receipts` writes evidence to stderr while stdout stays raw JSON.
   `tests/intel-cli.test.ts` has 93 passing tests, including a governed dispatch fixture for
   every command. The compiled `--help` executable was checked without provider calls.
   Important differences: default output is JSON rather than Rich tables (guide remains
   Markdown unless JSON mode is selected); rejected/degraded provider results use a nonzero
   exit status; writes need `--allow-writes` and an explicit data directory; custom report
   output is restricted to a non-overwriting filename inside that directory's reports
   folder. Source-specific `sync` remains explicitly not implemented, matching upstream's
   warning rather than pretending a refresh occurred. Click versions differ on automatic
   `_cmd` suffix removal; both `webcams` and legacy `webcams-cmd` are accepted. Short-option
   aliases with separate values are verified; full Click shell-completion/Rich/help-layout
   parity is not claimed.
4. **Collector daemon semantics need independent comparison.** Upstream has explicit
   once/daemon entrypoints, source-group filters, a default 300-second interval,
   SIGINT/SIGTERM shutdown and expired-cache eviction every 12 cycles. Compare whichever
   TS collector launcher is integrated against that lifecycle, not only collectOnce().
5. **Configuration choices are intentionally explicit.** Upstream discovers environment
   settings and default/fallback storage paths. Native runtime uses approved paths and
   passed credentials; byte-identical ambient configuration behavior is neither claimed
   nor desirable.
6. **Storage/embedding backend parity is semantic, not infrastructure identity.** Native
   SQLite/vector and local WASM embedding differ from upstream Qdrant/FastEmbed deployment.
   Model identity, dimensions, score/ranking fixtures, queue/shutdown behavior and optional
   backend-unavailable responses need separate evidence.
7. **Dashboard history dispatch uses the configured native history store**, rather than
   importing the Python collector roster under temporary logging-state restoration.
   Python-specific logger/thread mechanics are not reproduced.

Do not mark “100% parity” based solely on the tool registry or these mocked HTTP tests.
