# ADR-099: Darwin Mode — system audit dashboard (instrument validation)

**Status**: Accepted (measured)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-075 (reproducibility), ADR-091 (niches), ADR-094 (clade), ADR-096 (FDR), ADR-097 (curriculum)

> Before claiming the evolution engine is "beyond SOTA", prove it is a reliable scientific instrument. This ADR adds a dashboard that benchmarks the ENGINE — determinism, statistical rigor, clade productivity, niche diversity — not task accuracy. It reports real numbers, including the uncomfortable one.

## Decision

`bench/system-audit.mjs` (deterministic, seeded) runs real `evolve()` and emits one JSON of five metrics:

1. **determinismDivergence** — two same-seed runs; the scored-archive fingerprint must match. Success = 0.
2. **fdr.empirical** — feed `benjaminiHochberg` true-null `Uniform(0,1)` p-values over 40k trials; since all are null, FDR = P(any rejection). Judged against `q` within 3·SE (BH's guarantee is on the expectation, so a knife-edge compare would flip on Monte-Carlo noise).
3. **hge** — promoted / scored (a Huxley-Gödel clade-productivity proxy, ADR-094).
4. **nicheEntropy** — Shannon entropy `H = −Σ p ln p` of the behavioural-niche distribution (ADR-091); higher = less monoculture.
5. **adaptationLatency** — generations to first solve of a newly-admitted hard tier (ADR-097); `null` here (requires a graded multi-difficulty suite).

## Result (real, 2026-06-18)

| metric | value | reading |
|---|---|---|
| determinismDivergence | **0** | identical archive across same-seed runs — reproducible ✅ |
| fdr.empirical (q=0.05) | **0.049** (SE 0.0011) | ≤ q → **BH gate empirically controls FDR** ✅ (validates ADR-096 on null data) |
| hge | 0.0625 | low promotion rate — consistent with the gate ceiling |
| nicheEntropy / distinctNiches | **0 / 1** | **every variant in ONE niche** |
| adaptationLatency | null | requires a graded suite |

## The honest, important finding

`nicheEntropy = 0` (one occupied niche) is not a bug — it **empirically confirms the degenerate-manifold diagnosis** asserted across ADR-091/092/095/097: with a trivial task suite, every variant exhibits identical (trivial) behaviour, so the behavioural manifold collapses to a single point and *all* the diversity/steering machinery has nothing to act on. The dashboard turns a repeated qualitative claim into a measured fact, and gives the success signal for the curriculum (ADR-097): **nicheEntropy should rise above 0 once a graded difficulty ladder forces behavioural variety.** That is the next thing to watch.

## Consequences

- Two engine-level guarantees are now measured, not asserted: **byte-determinism (0)** and **FDR control (≤ q)**.
- The dashboard is the standing scoreboard for future work: the curriculum/difficulty-ladder's whole job is to drive `nicheEntropy` and the elite shell-depth up; this script measures whether it does.
- Metrics reuse already-tested primitives (`benjaminiHochberg`, `behavioralNiche`, `evolve`); the script is a committed artifact (`bench/results/system-audit.json`), not new production code.

## Validation

Script runs deterministically; raw output committed. No production path changed; the 336-test suite is unaffected.
