# ADR-127: Darwin Mode — the search/replace patch primitive (fixes ADR-126's large-file limitation)

**Status**: Accepted (measured) — new default patch primitive; resolves the ADR-126 finding
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-126 (whole-file repair regresses large files), ADR-124 (raw diffs corrupt), ADR-125 (runner)

> ADR-126 found whole-file repair reliable on small files but regressing `PASS_TO_PASS` on large ones (a full rewrite changes more than intended). ADR-124 found raw LLM unified diffs corrupt. The middle path — used by real coding agents (Aider) — is a **search/replace** edit: an exact `old → new` block. This makes it the runner default and validates it on the exact case ADR-126 could not resolve.

## The primitive

The model replies with one or more blocks (across files) in a sentinel format:

```
FILE: <selected filename>
<<<SEARCH
<exact lines copied verbatim from the file>
=======
<replacement lines>
>>>REPLACE
```

The runner applies each by **exact string match** in the named file (no line numbers, no whole-file rewrite, no JSON). It is:

- **Surgical** — only the matched region changes, so a large file is not rewritten → no collateral `PASS_TO_PASS` regressions (fixes ADR-126).
- **Corruption-proof** — verbatim match, no JSON control-char breakage (ADR-126) and no diff line-number drift (ADR-124).
- **Multi-edit / multi-file** — several blocks in one reply, so a multi-fault instance can resolve in a single attempt.

## Result (real, 2026-06-18)

```
Two-fault instance (pareto.ts small + phenotype.ts LARGE — the ADR-126 case):
  RESOLVED   F2P 5/5   P2P 17/17 (NO regression)   1 attempt   patchBytes 875   $0.0038   (stable across runs)
```

Both faults fixed by surgical edits to both files in a single reply, with **no `PASS_TO_PASS` regression** — the exact failure ADR-126's whole-file rewrite produced. The artifact is an 875-byte targeted change (vs whole-file's multi-KB rewrite), and it is ~3× cheaper.

## A second finding (file selection)

The instance only resolved once the `problem_statement` used **bare filename tokens** (`pareto`, `phenotype`). The harness's contextBuilder ranks by filename↔task term overlap, and a camelCase identifier like `paretoFront` tokenises to `paretofront` — which does **not** match the file `pareto.ts`. So natural-language bug reports that name camelCase symbols can mis-select files. Noted for step 3: the selection query should be normalized (split camelCase, or index symbol→file), or the contextBuilder should match on symbol tokens, not just path tokens.

## Consequences

- `patchMode` defaults to `searchreplace`; `wholefile` (ADR-124/125) remains available. ADR-126's experiment is pinned to `wholefile` so its limitation stays reproducible.
- ADR-126 → ADR-127 is the honest arc: surface the whole-file limitation, then fix it with a surgical primitive. Step 3's patch primitive is now search/replace (no large-file regressions).
- Open step-3 item: normalize file-selection for camelCase symbol names.

## Validation

Runner change + experiment + result committed (`bench/swe-bench-runner.mjs`, `bench/experiments/swe-bench-searchreplace.mjs`, `bench/results/swe-bench-searchreplace.json`). LLM results are not bit-reproducible but the outcome was stable across runs. 350 tests unaffected; committed `src/*.ts` verified clean (temp git repos used).
