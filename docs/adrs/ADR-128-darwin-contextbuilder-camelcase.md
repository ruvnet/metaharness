# ADR-128: Darwin Mode — contextBuilder camelCase tokenization (and the limit of path-based selection)

**Status**: Accepted (measured) — core harness fix for the ADR-127 file-selection finding
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-127 (camelCase selection finding), ADR-113 (ranking is causal), ADR-071 (contextBuilder surface)

## Context

> ADR-127 found the contextBuilder mis-selects files when a bug report names camelCase symbols: `paretoFront` lowercased+split to `paretofront`, which never matched the file `pareto.ts`. This fixes the tokenizer — and measures exactly how far a path-based fix can go.

## Decision

### Change

The `terms()` helper in `contextBuilderTemplate()` (the generated `context_builder.ts` surface, ADR-071) now splits camelCase **before** lowercasing:

```js
text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)
```

So `paretoFront` → `["pareto","front"]`, matching `pareto.ts`.

### Result (deterministic, 2026-06-18)

A/B over the 21 real `src` files, query `"paretoFront returns dominated items; poincareDistance fails near the boundary"` (`bench/experiments/camelcase-selection.mjs`):

```
                old tokenizer        new tokenizer
pareto.ts       rank 12, score 0  →  rank 1,  score 1     ✅ fixed
phenotype.ts    rank 13, score 0  →  rank 13, score 0     ✗ still unmatched
```

`pareto.ts` jumps from buried (rank 12, no match) to **rank 1**. But `phenotype.ts` stays unmatched — because the query symbol `poincareDistance` lives **in** `phenotype.ts` but shares no stem with the *filename*. No path-tokenization can fix that.

### Honest finding (the limit of path-based selection)

CamelCase splitting fixes selection when the symbol stem matches the filename, and does nothing when it doesn't. The general fix is **content/symbol indexing** — score files by the symbols they *define* (grep contents), not just by path tokens. That is a larger change: `buildContext` currently receives only file *paths* (a pure policy surface, no IO), so symbol-aware selection means changing the surface's input contract to carry file contents or a symbol index. Deferred as a step-3 item; recorded so it is not rediscovered.

## Consequences

- The contextBuilder is strictly better on camelCase queries (a real, common case) with zero risk — all 350 tests pass; the A/B is deterministic.
- Step-3 backlog gains a concrete, scoped item: symbol-aware selection (content indexing) to find symbols whose name ≠ filename. This is the remaining half of the ADR-127 finding.
- ADR-127 → ADR-128 honest arc: fix the cheap half (tokenization), measure and document the half a path-based approach cannot reach.

## Validation

Template change + experiment + result committed (`src/templates.ts`, `bench/experiments/camelcase-selection.mjs`, `bench/results/camelcase-selection.json`). Deterministic (bit-identical across runs, no network). Full suite: 350/350 pass.
