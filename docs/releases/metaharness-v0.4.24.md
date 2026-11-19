# metaharness 0.4.24: redblue 0.1.8 and Dream scoring fixes

Package: `metaharness@0.4.24` only.

## Dependency

`@metaharness/redblue` moves from `0.1.7` to `0.1.8`, the release that adds the blue-team defense layer (#513). The pin stays exact. The `dispatch(sub, args)` entry that `metaharness redblue` calls is unchanged, and `__tests__/pinned-deps.test.ts` loads the installed 0.1.8 `/cli` for real. The other five `@metaharness/*` pins are unchanged.

## Fixes

Evaluated Dream-cycle fixes merged since 0.4.23. Each one ships with a regression test.

- `threat-model` no longer reports a fabricated 0/0 tool count when it cannot read the tool surface (#479).
- `threat-model` no longer misses reachable secrets (`secretsReachable` false negative) (#459).
- `scoreMcpSafety` now reads `settings.json` before it awards the `mcpRisk` badge (#502).
- The SBOM `Component Hash` is no longer omitted or fabricated (#445).
- `repo-scorecard` no longer credits manifest-only tests to `compileConfidence`, `taskCoverage` (#489) or `scorePublishReadiness` (#451).
- An empty test directory no longer counts as tests (#435).
- `hasCi` no longer trusts generic "workflow" prose (#464).
- Both scaffold mirrors now emit the prime-agent `SANDBOX-REQUIRED.md` (#461).

## Tests

`packages/create-agent-harness`: 756 passed, 6 skipped.

No API changes.
