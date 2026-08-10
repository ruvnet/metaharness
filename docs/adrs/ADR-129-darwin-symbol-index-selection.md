# ADR-129: Darwin Mode — symbol-index file selection (closes the ADR-127/128 selection gap)

**Status**: Accepted (measured) — completes the file-selection finding
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-128 (camelCase tokenization — the tractable half), ADR-127 (selection finding), ADR-125 (runner)

## Context

> ADR-128 fixed selection when a symbol's stem matches its filename (`paretoFront`→`pareto.ts`) but showed path tokenization cannot find a symbol whose name differs from the file (`poincareDistance` ∈ `phenotype.ts`). This adds symbol indexing and closes that gap.

## Decision

### Change

The runner's `selectFiles()` augments the contextBuilder rather than replacing it (the contextBuilder stays a pure path-only surface). It extracts **identifier-like tokens** from the problem statement (camelCase / snake_case only — so plain words like "boundary" don't match), finds files that **define** any such symbol (`function|const|class|… <sym>`), prioritizes those, then fills the rest from the contextBuilder's path ranking. Symbol scan is orchestration-layer IO; `buildContext` is unchanged.

### Result

**Deterministic A/B** over the 21 real `src` files, query `"paretoFront returns dominated items; poincareDistance fails near the boundary"` (`bench/experiments/symbol-index-selection.mjs`):

```
path-only top-6:        pareto.ts, archive.ts, clade.ts, cli.ts, curriculum.ts, epistasis.ts   (phenotype.ts MISSED)
symbol-augmented top-6: pareto.ts, phenotype.ts, archive.ts, clade.ts, cli.ts, curriculum.ts   (BOTH targets ✓)
```

`phenotype.ts` enters the selection at #2 — found by its `poincareDistance` definition, which the path ranking missed. Deterministic (bit-identical across runs).

**End-to-end (real, $0.0037):** the natural camelCase bug report ("paretoFront … poincareDistance …") — which *failed selection* before — now runs end-to-end through `runSweBenchTask` and **RESOLVES: 5/5 F2P, 17/17 P2P, 1 attempt**, fixing both files. No bare-token workaround needed.

## Consequences

- The ADR-127 finding is fully closed: tokenization (128) handles stem-matching symbols; symbol indexing (129) handles symbols whose name ≠ filename. Selection now works on natural bug reports.
- `selectFiles` is exported from the runner and used for every instance; it composes with the contextBuilder (path ranking still breaks ties and fills non-symbol slots).
- Honest scope: the symbol scan is a lightweight regex over file contents (definitions only), not a full parser; it can over-select if a common camelCase token is defined in several files, but the `k`-cap bounds it and the contextBuilder ranking orders the remainder.

## Validation

Runner change + experiment + result committed (`bench/swe-bench-runner.mjs`, `bench/experiments/symbol-index-selection.mjs`, `bench/results/symbol-index-selection.json`). Deterministic A/B; one real end-to-end confirmation ($0.0037). Core `src` unchanged — 350 tests unaffected.
