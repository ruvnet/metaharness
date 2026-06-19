# ADR-151: deepseek-v4-pro lifts the cheap Barbarian floor 15.3% → 29.3%

**Status**: Accepted (measured)
**Date**: 2026-06-19
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-149 (V3 repair floor), ADR-148 (hybrid), issue #39 (decision criteria)

## Result (official `swebench` Docker harness, full 300, batch-verified, 0 errors)

| Barbarian (cheap, + repair) | resolved | Wilson 95% CI | ~$/instance |
|---|---|---|---|
| deepseek-V3 + repair (ADR-149) | 46/300 = 15.3% | [11.7, 19.8] | ~$0.01 |
| **deepseek-v4-pro + repair** | **88/300 = 29.3%** | **[24.5, 34.7]** | **~$0.11** |

**The cheap-model floor nearly doubled (15.3% → 29.3%) just by swapping the base model** — same
harness (localize + search/replace + ≤3 test-feedback repair), no frontier escalation. 209/300
non-empty patches (vs V3's 195). Cost ~$33.51 for the full 300.

## What this settles (the floor-test verdict, issue #39)

The ADR-149/150 hypothesis — "the `searchreplace`+repair *paradigm* is exhausted regardless of model
IQ" — is **falsified for the cheap-model axis**. A newer cheap model (v4-pro, Apr 2026, $0.43/Mtok)
moved the floor +14pp. So the agentic-architecture rewrite (the ADR-151-if-flatline branch) is **not
yet forced**; there is still resolve-rate to extract from this paradigm by riding model improvements.

Per issue #39 criteria, v4-pro alone ≥25% → **reconsider whether Scholar escalation is even needed**:
v4-pro-alone (29.3%) gets **88% of the V3+Scholar hybrid's resolves (33.3%) at ~⅓ the blended cost**
($0.11 vs $0.34/instance; no $99 frontier pass). The cheap-only ceiling rose to within a CI of the
old hybrid.

## Next lever (highest-value, queued)

**v4-pro Barbarian + Scholar hybrid**: escalate only the 212 instances v4-pro failed to a frontier
Scholar (sonnet-4). If the Scholar recovers ~20% of that tail (as it did on the V3 tail), the blended
result lands **~40%+** — a new ceiling, still cheap-base. This is now the top resolve-rate lever
(supersedes the agentic-rewrite urgency).

## Provenance
In-loop counter said 84; batch eval said **88** (in-loop under-counted ~5%, consistent with the
Scholar pattern — Docker-hang false-negatives). Only the batch number is reported. Report:
`bench/swebench/v4pro-repair-300-report.json` (resolved_ids = 88). Model `deepseek/deepseek-v4-pro`
(routes to `-20260423`).
