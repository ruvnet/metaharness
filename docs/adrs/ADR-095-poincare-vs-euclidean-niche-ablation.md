# ADR-095: Darwin Mode — Poincaré vs Euclidean niche ablation (Gap 1)

**Status**: Accepted (measured) — honest, nuanced result
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-091 (hyperbolic phenotyping), ADR-092 (niche steering), ADR-088 (MAP-Elites). Closes the horizon-tracker's **Gap 1** (the biggest credibility gap: Poincaré-ball QD niches have zero published prior art and, until now, zero ablation).

## Context

> A reviewer's first demand: does the hyperbolic geometry actually buy diversity, or is it decorative? This ADR runs the controlled comparison and reports the result honestly — including where Euclidean wins.

### Method

Bin the SAME embedded behaviour points with the production binning functions (`poincareNicheOf` polar radial-shell grid, 4×6=24 cells; `euclideanNicheOf` flat Cartesian grid, 5×5=25 cells — matched budget) under two synthetic regimes, seeded/deterministic (`bench/ablation/poincare-vs-euclidean.mjs`):

- **hierarchical** — 8 strategies arranged by DEPTH (radius grows with strategy index), the realistic structure for agent behaviour (shallow→deep struggle).
- **uniform** — 8 strategies spread uniformly by area (a control neutral to either geometry).

Metrics: distinct niches occupied, and **strategy separation** = fraction of distinct-strategy pairs that never share a niche (higher = better diversity resolution). 40 noisy samples/strategy.

## Decision

Adopt the ablation's measured, narrow conclusion as the basis for keeping the hyperbolic niching: the sections below record the raw result, its honest interpretation, and the caveats, all verbatim.

### Result (real, 2026-06-18)

| regime | metric | Poincaré | Euclidean |
|---|---|--:|--:|
| hierarchical | strategy separation | **1.000** | 0.929 |
| hierarchical | distinct niches | **12** | 11 |
| uniform | strategy separation | 0.857 | **0.929** |
| uniform | distinct niches | 11 | 8 |

### Honest interpretation

- **On hierarchically/radially-structured behaviour — the realistic case for agents that differ by struggle-depth — Poincaré niches separate strategies better** (perfect 1.000 vs 0.929) and occupy more distinct niches (12 vs 11). The polar radial-shell grid resolves depth structure that a uniform Cartesian grid partially compresses.
- **Poincaré is NOT universally superior.** On uniformly-distributed behaviour, Euclidean wins separation (0.929 vs 0.857) — exactly as expected, since an area-uniform square grid is the right tool for area-uniform data. This is the control passing; the ablation is not rigged.
- **The advantage is real but modest** on this synthetic data, and **conditional** on the behaviour being hierarchical. The honest claim is therefore narrow: *Poincaré niches are the better container for depth-structured agent behaviour*, not "non-Euclidean is universally optimal."

### Caveats (stated, not hidden)

- This isolates the **binning geometry** on controlled point sets. It is **not** a claim about a learned low-distortion tree embedding (`poincareEmbed` is a hand-crafted map, not a trained embedder), and not about the steering distance metric (tested separately in ADR-091/092).
- A **live** evolve ablation is currently confounded by the degenerate manifold (trivial tasks keep all variants at low radius — the benchmark-saturation Gap 3): the high-radius frontier where the geometries most differ is unpopulated until a difficulty ladder forces struggle. So the synthetic study is the honest proxy until Gap 3 is closed.

## Consequences

- The hyperbolic phenotyping (ADR-091) and steering (ADR-092) are **justified for the realistic (hierarchical) regime**, with measured evidence — no longer asserted. Keep them; default selection remains `score` so nothing is forced.
- Next: close **Gap 6** (Benjamini–Hochberg FDR control on the promotion gate) and **Gap 3** (difficulty ladder), after which a *live* (non-synthetic) ablation becomes meaningful.

### Validation

Deterministic ablation harness committed (`bench/ablation/poincare-vs-euclidean.mjs`); raw numbers in `bench/results/poincare-vs-euclidean-ablation.json`. No production code path changed; `euclideanNiche`/`poincareNicheOf`/`euclideanNicheOf` added as the comparator + shared binning helpers (used by `behavioralNiche`), 326 tests unchanged.
