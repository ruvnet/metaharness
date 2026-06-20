# ADR-154: Three-tier cheap→frontier→frontier hybrid — 58.3% on SWE-bench Lite (verified)

**Status**: Accepted (measured + reproducibility-verified)
**Date**: 2026-06-19
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-152 (2-tier 40.3%), ADR-151 (v4-pro), ADR-148/149 (repair/hybrid)

## Result (official `swebench` Docker harness, full 300, batch-verified)

| stage | resolved | Wilson 95% CI | ~$/inst blended |
|---|---|---|---|
| baseline (open-loop) | 23/300 = 7.7% | [5.2, 11.2] | ~$0.01 |
| + repair (deepseek-V3) | 46/300 = 15.3% | [11.7, 19.8] | ~$0.01 |
| v4-pro base + repair | 88/300 = 29.3% | [24.5, 34.7] | ~$0.11 |
| + Scholar (sonnet-4) 2-tier | 121/300 = 40.3% | [28.2, 38.8]→[34.9,46.0] | ~$0.39 |
| **+ Sage (opus-4.8) 3-tier** | **175/300 = 58.3%** | **[52.7, 63.8]** | ~$0.74 |

**58.3% — 7.6× the open-loop baseline.** Tiers: v4-pro Barbarian (88) → sonnet-4 Scholar on the
212-tail (+33 → 121) → opus-4.8 Sage on the residual (+54 → 175).

## Reproducibility (why this surprising number is trusted)

The Sage's in-loop counter said 23 but the batch eval credited +55 — a 2.4× gap, larger than any prior
run. Cause: during the contended opus run the loop was repeatedly `docker kill`-ing wedged eval
containers (requests-2317 et al.), which marked many *correct* patches as unresolved in-loop. Resolved
the doubt with an **independent re-eval of all 55 Sage-added instances under a fresh run_id → 55/55
reproduced (100%)**. The batch number is authoritative; the in-loop was a false-negative artifact.

## This is a conservative LOWER bound

- The **Sage tier was partial** (144/179 of the residual; the $500 budget guard stopped it). The
  remaining 35 residual instances were never attempted by opus → counted unresolved. A complete Sage
  pass can only raise 58.3%.
- `psf__requests-2317` errored (Docker hang) → counted unresolved (KNOWN_FLAKY.md). n=300 throughout.

## Cost

Blended ~$0.74/instance for the full 3-tier on 300: v4-pro $33.51 + sonnet-4 $84.23 + opus-4.8 (144)
~$104 ≈ $222. Still far below running a frontier agent on all 300 at $1–20/instance — the cheap base
banks 88 and each tier only pays for the shrinking residual.

## Verdict

The cheap-base + tiered-frontier-escalation paradigm reaches **58.3%** on SWE-bench Lite — into the
SOTA-adjacent band, and a *lower bound*. The mid-arc "architecture ceiling at 15.3%" was emphatically
wrong as a paradigm limit: 15.3% → 58.3% via compounding model + tiering levers, every step
batch-verified. The agentic-loop architecture (ADR-153) remains the path to the very top (65–88%),
but escalation had far more headroom than assumed.
