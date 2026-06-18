# ADR-126: Darwin Mode — iterative repair loop, regression-aware feedback, and robust patch parsing

**Status**: Accepted (measured) — runner capability upgrade + an honest limitation finding
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-125 (consolidated runner), ADR-124 (whole-file primitive), ADR-123 (resolved criterion)

> ADR-125's runner did one shot per instance. This adds an iterative **repair loop** (feed failing tests back, retry up to N), **regression-aware feedback** (also report newly-broken `PASS_TO_PASS`), and **robust patch parsing**. The robust parsing fixes a real latent bug; the repair loop helps on single-fault instances and surfaces an honest limitation on multi-fault/large-file ones.

## Changes to `runSweBenchTask`

1. **Repair loop** — up to `maxAttempts` (default 3): apply a whole-file fix, re-score; if unresolved, retry with feedback.
2. **Regression-aware feedback** — the next prompt lists both still-failing `FAIL_TO_PASS` *and* any `PASS_TO_PASS` a prior attempt regressed ("do not change their behaviour").
3. **Robust patch parsing** — the model now replies in a **sentinel format** (`FILE: <name>` then content between `<<<CONTENT … CONTENT>>>`) instead of JSON. This fixes a real latent failure: encoding a code blob as a JSON string breaks `JSON.parse` whenever the model emits **raw (unescaped) newlines** in the string — observed as "Bad control character in string literal" — which would also have bitten ADR-125's runner on larger files.

## Result (real, 2026-06-18)

```
Single-fault instance (upgraded runner):  RESOLVED   F2P 4/4   P2P 18/18   2 attempts   $0.012
Two-fault instance (pareto + phenotype):  UNRESOLVED F2P 4–5/5 P2P 6–17/17 (high variance) up to 4 attempts
```

- **Single-fault**: the repair loop reliably converges — RESOLVED under the real criterion.
- **Two-fault**: repair drives `FAIL_TO_PASS` from 0/5 up toward 5/5 across attempts (the feedback loop works and targets different files), but it does **not reliably resolve**: the model's whole-file rewrite of the **large** `phenotype.ts` regresses several `PASS_TO_PASS` tests, and the criterion correctly withholds RESOLVED. File-selection across attempts is also high-variance (the model sometimes refixes the same file).

## Honest finding

Whole-file repair (the ADR-124 primitive) is reliable for **small** files but, on **large** files, a full rewrite introduces collateral regressions — exactly what `PASS_TO_PASS` is designed to catch. The repair loop + regression-aware feedback is the right *mechanism* but cannot fully compensate for whole-file rewrites of large files. This is a genuine limitation, surfaced rather than hidden, and it sharpens step 3:

- **Step-3 implication**: large-file instances need **surgical (diff/region) patching**, not whole-file rewrite, plus stronger file-selection (the model should be told which file each remaining failure lives in). The validate-and-repair loop stays; the patch granularity must shrink.

## Consequences

- The runner is more robust (sentinel parsing closes a latent crash) and self-healing on single-fault instances; the multi-fault limitation is documented for step 3.
- No overclaim: the headline single-fault path resolves; multi-fault whole-file repair is explicitly *not* reliable yet.

## Validation

Runner change + both experiments + results committed (`bench/swe-bench-runner.mjs`, `bench/experiments/swe-bench-repair.mjs`, `bench/results/swe-bench-repair.json`, refreshed `swe-bench-run.json`). LLM results are not bit-reproducible (model variance — especially the two-fault run). 350 tests unaffected; committed `src/*.ts` verified clean (temp git repos used).
