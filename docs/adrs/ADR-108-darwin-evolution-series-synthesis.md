# ADR-108: Darwin Mode evolution series — synthesis, evidence, and status

**Status**: Accepted (synthesis / index)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Indexes**: ADR-084 … ADR-113 (the evolution stack built on the ADR-070…083 baseline)

> One document a reviewer can read to understand the whole contribution. Darwin Mode's differentiator is not a model — it is an **auditable, statistically-gated, recursive lineage**: a self-improving agent harness where every claim is a committed, reproducible number and every limitation is recorded. This ADR is the provenance.

## The arc (what was built, in order)

1. **Engine** (ADR-070…083, prior): frozen model + evolving harness over 7 mutation surfaces; sandbox; immutable scorer; archive-as-tree; safety gate.
2. **Variation** — failure-driven mutation (084), LLM mutator + 15-model polyglot model frontier (085), sibling-diversity nonce fixing one-directional mutation (104), genetic crossover (089), epistatic linkage / topology-aware crossover (093).
3. **Selection** — efficiency tie-break (086), MAP-Elites (088), hyperbolic Poincaré phenotyping (091) + niche steering (092), clade metaproductivity / Huxley-Gödel (094), multi-objective Pareto (100).
4. **Acceptance** — graded statistical promotion over a hash-pinned suite (087), SGM cumulative risk budget (090), Benjamini-Hochberg FDR control (096), self-directed curriculum (097).
5. **Substrate** — the keystone: `real` (repo test, surface-independent) → `mock` (deterministic surface-param simulation, 102) → `agent` (real surface **code** execution via child strip-types process, 106) → real-LLM eval PoC (107).
6. **Validation** — system-audit dashboard (099), Poincaré-vs-Euclidean ablation (095), self-improvement demonstrated (103), diversity-beats-greedy-on-deception (105).
7. **Real-substrate proofs** — Tier-2 real surface-code execution (106), real-LLM fixes a real test (107), surface gates the real LLM (109), evolution lifts a real LLM's real-test pass-rate (110).
8. **Adversarial self-correction** (after a critical external review) — falsified "ranking determines outcomes" → it's window size for flat distractors (111), but ranking IS causal when relevance varies (113); falsified FDR control at n=3 → guarded at n≥5 (112). Claims trued-up, not defended.

## The evidence (real, reproducible — `packages/darwin-mode/bench/results/`)

| Finding | ADR | Number |
|---|---|---|
| Cheap beats frontier for code | 085 | DeepSeek-V3 ($0.4/Mtok) tops 15-model × 6-language execution frontier on quality/$ |
| Determinism | 099 | archive divergence **0** across same-seed runs |
| FDR control works (n≥5 only) | 099/112 | empirical FDR **0.049 ≤ 0.05** on uniforms; on real bootstrap p-values BH controls FDR at **n≥5** task-scores, NOT n=3 (33%, ADR-112) |
| Hyperbolic niches help (conditionally) | 095 | depth-structured: Poincaré sep **1.000** vs Euclidean 0.929; uniform: Euclidean wins (honest) |
| Manifold goes live | 102 | nicheEntropy **0 → 0.69**, finalScore **flat 0.985 → 0.435–0.802** under `mock` |
| Self-improvement | 103 | evolves contextBuilder window 30→70, finalScore **0.765 → 0.985** |
| Diversity > greedy on deception | 105 | greedy **0/5**, behavioral-diversity **5/5**, clade 4/5 |
| Real surface code drives outcome | 106 | window 30/50/80 → solves **1/2/3** tasks (Tier-2); self-improves 0.618→0.985 |
| Surface gates real LLM (window, not ranking — corrected) | 109/111 | wide window lets a real LLM fix a real test a narrow one can't; **ranking untested** (ADR-111 falsification) |
| Real-LLM eval path | 107 | real failing test → 1 model call → real test PASSES, **$0.0005** |

## Honest open problems (recorded, not hidden)

- **Real-world fidelity**: all in-loop validation uses deterministic mock/agent substrates. Real LLM-on-real-SWE results require ADR-098 (below) — no benchmark claims are made until a real run exists.
- **Clade < behavioral-diversity** (4/5 vs 5/5): clade explores but doesn't pair complementary stepping-stones; a trace-niche-diversity fix was net-neutral and reverted (105 follow-up). Closing it needs a *parameter-aware* (genotypic) diversity signal — future.
- **Strong deception** (needs two surfaces far past baseline) is crossed by *none* of the strategies (105) — an honest capability ceiling.
- **Mutator scope**: deterministic edits are bounded perturbations; the rich path is the LLM mutator (085).

## The frontier: ADR-098 (deferred, well-scoped)

Real LLM solving real SWE-bench-style tasks. **Every piece is now independently proven** — Tier-2 child execution + safety + trace (106), real-test oracle + statistical/FDR gate (087/096), a real model fixing a real test (107). The remaining build assembles them on a real multi-file task corpus where the surfaces measurably shape the agent loop. It is token-costly and deliberate — a focused session, not an autonomous tick.

## Status

A **working, empirically-validated, fully-documented, and adversarially self-corrected** self-improving evolutionary harness: 30 ADRs (084–113), 349 tests, every selection/variation/acceptance mechanism opt-in over a frozen reproducible core. The manifold is demonstrably live, self-improvement and diversity-superiority are measured (mock substrate), the real substrate is proven end-to-end (real surface code → real LLM → real test, with the surface causally gating capability), and a critical external review's three findings have been addressed with reproducible experiments (two corrections + one completion). What remains is **scale**: the real-substrate two-surface epistatic search and the SWE-bench corpus (ADR-098) — token-costly, deliberate, no new mechanism. The scientific product is the provenance: this series, including the parts that falsified and corrected its own claims.
