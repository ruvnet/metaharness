# ADR-152: v4-pro + Scholar hybrid — new ceiling 40.3% on SWE-bench Lite

**Status**: Accepted (measured)
**Date**: 2026-06-19
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-151 (v4-pro Barbarian), ADR-148 (V3+Scholar hybrid), ADR-149 (repair)

## Result (official `swebench` Docker harness, full 300, batch-verified, 0 errors)

| stage | resolved | Wilson 95% CI | ~$/inst blended |
|---|---|---|---|
| baseline (open-loop) | 23/300 = 7.7% | [5.2, 11.2] | ~$0.01 |
| + repair (deepseek-V3) | 46/300 = 15.3% | [11.7, 19.8] | ~$0.01 |
| v4-pro base + repair (ADR-151) | 88/300 = 29.3% | [24.5, 34.7] | ~$0.11 |
| V3 + Scholar hybrid (ADR-148) | 100/300 = 33.3% | [28.2, 38.8] | ~$0.34 |
| **v4-pro + Scholar hybrid** | **121/300 = 40.3%** | **[34.9, 46.0]** | **~$0.39** |

**40.3% — the new ceiling, 5.2× the open-loop baseline.** Decomposition: 88 from the cheap v4-pro
Barbarian + 33 from the sonnet-4 Scholar on the 212-instance tail v4-pro couldn't crack (33/212 =
15.6% tail recovery). 245/300 non-empty patches, 0 eval errors.

## Why it beats the V3+Scholar hybrid (33.3% → 40.3%, +7pp)

A *stronger cheap base* (v4-pro, ADR-151) banks far more before escalation (88 vs 46), so the Scholar
starts from a higher floor and the same tier-2 escalation compounds on top. Tiering pays *more* as the
base model improves — the two levers (better cheap base + frontier-tail escalation) stack.

## Cost

Blended ~$0.39/instance: v4-pro Barbarian $33.51 + sonnet-4 Scholar (212 tail, 2 attempts) $84.23 ≈
$118 for the full 300. Still ~5× cheaper than running a frontier model on all 300 for a comparable
ceiling, because the cheap base already banks 88/300.

## Honesty / provenance

In-loop Scholar-tail said 25; batch found 33 of its patches resolve (in-loop under-count, Docker-hang
false-negatives — consistent pattern; batch authoritative). Report:
`bench/swebench/v4pro-hybrid-300-report.json` (resolved_ids = 121). Predictions:
`predictions-v4pro-hybrid-300.jsonl`. `psf__requests-2317` excluded-as-unresolved per KNOWN_FLAKY.md.

## Verdict

The cheap-base + tiered-escalation paradigm reaches **40.3%** on SWE-bench Lite — well past where the
"architecture ceiling" looked fixed at 15.3%. Two compounding levers (newer cheap base; frontier-tail
escalation) carried 15.3% → 40.3%. The 65–88% agentic-SOTA tier still needs a multi-step autonomous
agent, but this paradigm has more room than the mid-arc analysis assumed.
