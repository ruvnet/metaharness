# ADR-118: Darwin Mode — the SWE-nucleus loop generalizes across varied real bugs

**Status**: Accepted (measured) — generalization of ADR-117
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-117 (single-bug SWE nucleus), ADR-113 (ranking causal), ADR-098 (frontier)

## Context

> ADR-117 fixed one real multi-file bug end-to-end. The obvious skeptic's question: a fluke? This runs five independent bugs across different domains through the same real loop. 5/5.

## Experiment

Five independent multi-file repos, each a real bug + a real test + plausible varied-relevance distractors (`bench/experiments/swe-suite.mjs`). For each: the variant's real `contextBuilder` ranks/selects files → the real LLM (gemini-2.5-flash) gets the selected files' actual content + the failing test and must identify the buggy file and fix it → the real test is the verdict.

| task | domain | the real bug |
|---|---|---|
| intervals | algorithms | touching intervals not merged (`<` vs `<=`) |
| slugify | strings | leading/trailing dashes not trimmed |
| gcd | math | negative inputs give a negative result |
| chunk | arrays | `n ≤ 0` → infinite loop |
| query | parsing | key without `=` → `undefined` instead of `''` |

## Decision

### Result (real, 2026-06-18)

```
fixed: 5/5      chose-correct-file: 5/5      total cost: $0.00114
every task: contextBuilder ranked the buggy file #1, the LLM chose it
(rejecting the distractors), reasoned out the fix, and the real test passed.
```

The loop is **not** a one-bug fluke: across five domains it (1) ranks the right file by relevance among distractors, (2) the real LLM identifies it and (3) reasons out a correct fix from the real code, (4) confirmed by a real test — 5/5 for ~$0.001.

### Significance

This is robust unit-level evidence that the ADR-098 evaluation loop works on *varied* real code: real surface selection + real multi-file LLM reasoning + real-test verdict generalize across bug types, not just the one merge-intervals case (ADR-117). Combined with the rest of the series, the only thing standing between this and a real SWE-bench number is scale and a real corpus.

### Honest scope

- **Hand-built repos** (3 files each, clear bugs a capable model fixes) — designed to test the *loop's generalization*, not model coding difficulty. Real SWE-bench tasks are larger, under-specified, multi-file-patch, and noisy; pass-rate there will be far below 5/5.
- 5 independent calls, no caching; not wired into `evolve()` (per-variant cost). The remaining ADR-098 build is **scale + a real corpus + a budget**, no new mechanism.

## Consequences

- The real-substrate capability is now demonstrated across a small *suite*, not a single example — the strongest pre-SWE-bench evidence the series can produce without a real corpus.
- The natural next rung (not done autonomously — token/scope) is wiring this evaluator into `evolve()` over a real multi-task corpus so the harness self-improves measured by real-LLM-real-test pass-rate at suite scale.

## Validation

Suite + result committed (`bench/experiments/swe-suite.mjs`, `bench/results/swe-suite.json`). No package code changed; 350 tests unaffected.
