# ADR-117: Darwin Mode — real multi-file SWE nucleus (surface-selected, LLM-reasoned, real test)

**Status**: Accepted (measured PoC) — the ADR-098 nucleus with real content
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-109 (surface gates real LLM, hardcoded fix), ADR-113 (ranking causal when relevance varies), ADR-098 (SWE-bench frontier)

## Context

> ADR-109 proved the surface gates a real LLM's *access*, but used a hardcoded fix. The genuine SWE step is the LLM *reasoning over real multi-file code* — choosing which file is buggy and fixing it — with a real test as the only verdict. This is that, at micro scale.

## Decision

`bench/experiments/swe-nucleus.mjs`: a 5-file repo (`intervals.js` carries a real touching-merge bug; four plausible, varied-relevance distractors: `sort.js`, `format.js`, `overlap_utils.js`, `merge_report.js`) + a real Node test. The loop:

1. The variant's **real** `contextBuilder` ranks the files for "fix the merge intervals bug" and selects the top set.
2. The **real** LLM (gemini-2.5-flash) is given the *selected files' actual content* + the failing test and must return `{file, content}` — identifying the buggy file **and** fixing it from the code (no hardcoded fix).
3. The patch is applied and the **real test command** is the verdict.

## Result (real, 2026-06-18)

```
contextBuilder ranked intervals.js #1 of 5 (relevance)   → buggy file selected ✓
LLM chose file: intervals.js (correct, not a distractor) → fix applied
real test: FAIL → PASS                                   → verdict: FIXED
583 tokens, $0.00046, 1.1 s
```

The real contextBuilder surfaced the right file by relevance (ADR-113), and the real LLM **reasoned over the real multi-file code** to both *select* the buggy file (rejecting four distractors) and *fix* it — confirmed by the real test, for ~$0.0005.

## Significance

This closes the last fidelity gap below a real SWE-bench run: every prior real-substrate result either used a hardcoded fix (ADR-109/110) or a synthetic agent loop (ADR-106). Here the LLM does genuine multi-file reasoning (which file? what fix?) over real source, gated by the evolvable surface, judged by a real test. The chain is now real end-to-end at the unit level.

## Honest scope

- A **hand-built 5-file repo, one bug, one model call** — a nucleus, not a benchmark. Real SWE-bench tasks are larger, under-specified, multi-file-patch, and noisy.
- Not wired into `evolve()` (per-variant LLM cost). The remaining ADR-098 build is **scale + a real corpus + a token budget** — assembling the now-complete machinery (real contextBuilder selection + real multi-file LLM reasoning + real-test/FDR gate + Tier-2 child execution), not a new mechanism.

## Consequences

- The provenance (ADR-108) now reaches genuine multi-file LLM reasoning over real code — the strongest unit-level evidence short of SWE-bench.
- ADR-098 is de-risked to engineering + budget; this PoC is its literal nucleus.

## Validation

PoC + result committed (`bench/experiments/swe-nucleus.mjs`, `bench/results/swe-nucleus.json`). No package code changed; 350 tests unaffected.
