# ADR-146: Darwin Mode — LLM file-localization lifts recall +15pp but exposes the "emission wall"

**Status**: Accepted (measured) — Stage-B context fix; recall win, resolve-rate flat, bottleneck relocated
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-144 (full-300 baseline 7.7%), ADR-142 (empty-patch flag), ADR-143 (repair loop), ADR-126/127 (search/replace)

## Context

> ADR-144's baseline had a 67% empty-patch rate. The diagnostic (this ADR's first half) showed **selection recall was only 44.7%** and 65% of empties were selection-misses → localization was the indicated fix. This ADR ships it, measures it on the full 300, and reports an honest result: **recall rose +15pp, but resolve-rate did not move** — the bottleneck relocated from retrieval to patch-emission.

## Change

`solve.mjs --localize` (ADR-146): lexically pre-prune ~120 candidates, show the model **paths + def/class signatures only** (cheap), let it pick the top-k files to edit; lexical ranking fills remaining slots. Opt-in (baseline stays reproducible).

## Result (real, full 300 SWE-bench Lite, 2026-06-18)

| metric | baseline (ADR-144) | + localize | delta |
|---|---|---|---|
| **selection recall** (gold file selected) | 44.7% | **59.7%** | **+15.0pp** |
| patch production | 33.3% | 31.7% | −1.3pp (flat) |
| **resolved** | 23/300 = 7.7% [5.2, 11.2] | **24/300 = 8.0% [5.4, 11.6]** | +0.3pp (**within noise**) |
| empties: selection-miss / emission | 65% / 35% (70 abs) | 49% / **51% (104 abs)** | composition **flipped** |
| solve cost | $2.75 | $3.35 | +$0.60 |

## Honest interpretation — the "emission wall"

- **Localization works as designed:** the LLM localizer finds the gold file **15 absolute points** more often than the lexical contextBuilder (44.7%→59.7%). The architectural change is validated.
- **But resolve-rate is flat (7.7%→8.0%, CIs almost fully overlapping).** The recall gain did **not** convert to resolutions.
- **Why — the bottleneck relocated.** The empty-patch composition flipped: emission-wall failures (gold file *was* selected, yet no valid patch emitted) went from 35%→**51%** of empties, **70→104 absolute**. Localization handed the model the correct file in ~34 more cases and it failed to emit a usable search/replace in **every one** of them. The problem moved from *"can't find the bug"* to *"can't write the patch."*
- **Conclusion:** retrieval is no longer the binding constraint; **patch-emission is.** Single-shot emission against a correct-but-large/complex file is the wall. This is precisely what closed-loop repair (ADR-143) targets — feed the apply-rejection / pytest traceback back so the model corrects its own emission.

## Decision → Stage B2 (repair loop) is the justified next lever

Stack the ADR-143 closed-loop repair (run `FAIL_TO_PASS` in Docker, feed failure back, retry ≤3) **on top of `--localize`**, on the full 300. Localization ensures the right file is in context; the repair loop attacks the emission wall it exposed. This is the direct countermeasure to the measured bottleneck — not a guess.

## Consequences

### Honest scope / cost

- Recall is measured against gold-patch file paths (no LLM); resolve-rate by the official harness. n=300, tight CIs.
- Localization adds ~$0.60 (the extra localize call/instance) for no resolve-rate gain *standalone* — it is a **prerequisite** for the repair loop's value, not a standalone win.
- Closed-loop-300 is the heaviest run (300 × ≤3 Docker test-runs); budget is fine (~$4.6/$250), Docker time is the constraint. Only at n=300 is the repair-loop effect statistically resolvable (the n=25 A/B was +4pp within noise).

## Validation

Solver (`--localize`), predictions, official report, diagnostic, and analysis committed under `bench/swebench/`; recall + resolve-rate + Wilson CIs reproducible.
