# ADR-201: Vector-Memory Ablation — does GraphRAG (ruvector) lift cheap models over the turn-budget cliff?

**Status:** Proposed (build $0 now; paid empirical proof gated on budget allocation)
**Date:** 2026-06-28
**Related:** ADR-194 (crack-the-tail), ADR-198 (weight-eft), the cheap-vs-frontier research (`docs/research/cheap-vs-frontier/`), §5b harness-artifact schema.

## Context

The cheap-vs-frontier campaign proved that on everyday-agentic work (FRAMES QA, BFCL tool-use) cheap models (DeepSeek-V4-Pro, GLM-5.2) are at parity-or-better with older-frontier at 2–56× lower cost, but the gap **persists on hard code** (SWE-Pro 4% turn-budget cliff). The hypothesis under test here: **vector memory shifts the burden from parametric knowledge (frontier's moat) to in-context synthesis (where cheap models punch up)** — and a *graph*-structured, self-learning store (`ruvector`, Rust GNN + vector DB, npm `ruvector@0.2.x`) could push the deep relational reasoning out of the LLM and into the data layer, extending cheap-model survival before the Opus hand-off.

**This bifurcates the Pareto curve again** and is dual-edged: it should help everyday knowledge tasks (knowledge-flattening) but may *hurt* hard code (context-distraction) by overloading weak long-context attention. We test both directions.

## Hypotheses (falsifiable — the brief's numbers are PREDICTIONS to prove, not facts)

Predictions below are **recalibrated to published evidence** (`docs/research/cheap-vs-frontier/VECTOR-MEMORY-EVIDENCE.md`, deep-researcher 2026-06-28); the brief's original figures were overstated.

| # | Hypothesis | Evidence-grounded prediction | Falsified if |
|---|-----------|------------------------------|--------------|
| **H1 — Knowledge flattening** | Vector RAG lifts cheap models on domain QA, **disproportionately** (Δ_cheap > Δ_frontier) | **+5–11 pp** cheap lift (NOT the brief's +12–18); ~1.7× disproportionality (med-QA, M4-RAG). Confound: ≤7B models fail to use even *oracle* context 85–100% of the time | Δ_cheap ≤ Δ_frontier, or lift < CI |
| **H2 — Context-distraction penalty** | Cheap models degrade as retrieved-context tokens grow; differential worse for open/cheap | Open models collapse past **~7k (7B) / 16–32k (70B)**; Opus ~89%@1M single-needle. Brief's "Opus 98%@100k / cheap 60%@10–20k" NOT established | cheap recall flat across context length |
| **H3 — GraphRAG > dense** | GraphRAG feeds fewer/better tokens (Cr>0) → higher multi-hop resolve than dense at ≤ cost; extends turn-budget survival | Multi-hop **+5–10 pp** established (HippoRAG2/GraphRAG); **SWE-bench applicability is extrapolation** (no paper tests GraphRAG on code agents); Cr is impl-dependent (some GraphRAG modes *increase* tokens); bias-corrected wins can be <8% | Test B ≤ Control A, or Cr ≤ 0 |
| **H4 — GNN self-learning** | After a feedback warm-up epoch, re-running the same tasks lifts resolve | **>5%** (recalibrated from brief's >15% — no peer-reviewed precedent above ~8.6%; SimRAG 1.2–8.6%) | Epoch1 ≤ Epoch0 + CI |

**ruvector v0.2.32 reality (verified):** SHIPPED — `.rvf` COW snapshots (~2.6ms/10K branch), Cypher (limited, ~5ms), GNN lib (`@ruvector/gnn`). UNVERIFIED/marketing — `memory_feedback` API by name (not in docs → build behind our own seam), "12µs warm queries" (not in docs; real: SIMD distance 14.9ns, HNSW sub-ms, Cypher ~5ms), "30–60% improvement" (no cited benchmark). The harness wires to *shipped* calls only; unshipped capabilities are stubbed behind the memory-layer interface.

**Integrity:** every prediction is a target to measure, not assert. Conformance firewall holds (no gold in the solve loop; feedback uses solve outcomes, gold only scores). Real numbers + Wilson CI. **Genuine null risk:** the context-utilization-failure confound (H1) and the SWE-bench extrapolation (H3) mean vector memory may show little or negative lift — especially BACKFIRING on hard code by overloading weak attention. Report whichever way it lands.

## Experimental design (A/B/C parallel swarms)

Fixed seed, same instances per swarm. Everyday axis: FRAMES (n≥50, knowledge-flattening for H1/H2). Hard axis: SWE-bench Lite (n=150) + Pro (n=50) for H3/H4.

| Swarm | Base | Memory | Routing | Measures |
|-------|------|--------|---------|----------|
| **Control A** | GLM-5.2 / DS-V4-Pro | Standard dense (pgvector/in-proc) | hard bail → Opus @60 steps | baseline resolve + cost |
| **Test B** | same | **ruvector** (GraphRAG + `.rvf`) | hard bail @60 | retrieval lift Δ vs A; Cr |
| **Test C** | same | ruvector | **dynamic bail** (GNN confidence < τ) | turn-budget extension S_T + cost savings |

## Telemetry / metrics

- **Retrieval Lift Δ** = resolve(with-RAG) − resolve(base, no-RAG). Expect Δ_cheap ≫ Δ_frontier (H1).
- **Context Payload Compression Cr** = 1 − tokens_ruvector / tokens_dense. (H3: GraphRAG sends fewer tokens.)
- **Context Degradation Rate** = resolve vs retrieved-token-length → the token count where cheap attention fails (H2). The mechanistic link to ADR's turn-budget cliff.
- **Turn-Budget Survival S_T** = % resolved by cheap model WITHOUT Opus fallback. (H3/C.)
- **Cost-Adjusted Lift L_C** = Δresolve / Δcost — guards the $0.267 floor isn't cannibalized.
- **Cost-per-correct-hop** = (embed + context cost) / correct semantic hops.

## GNN warm-up protocol (proves self-learning, H4)

1. **Epoch 0 (explore):** run the subset; record trajectories.
2. **Feedback:** reinforce edge weights in the `.rvf` via ruvector feedback API (+w for retrieval paths on resolved instances, −w on failed). *Conformance: feedback uses solve outcomes, NOT gold patches — no oracle leak.*
3. **Epoch 1 (exploit):** re-run the SAME instances on the weighted `.rvf`. H4 holds iff Epoch1 > Epoch0 + CI.

## Phasing & budget

- **Phase 0 ($0, now):** verify ruvector real capabilities; build the ablation harness (`packages/darwin-mode/bench/ruvector/`: A/B/C runner, dense-RAG baseline, telemetry, `.rvf` snapshotting); deep-researcher verifies/cites H1/H2 published evidence; dry-run at $0.
- **Phase 1 (paid, GATED):** the A/B/C × 2-epoch run is expensive (SWE-bench × 3 swarms × 2 epochs ≫ the ~$35 left of the $200 cheap-vs-frontier budget). Needs a **new budget allocation**; until then, a **minimal pilot** (FRAMES n=40 H1 + a small SWE-Lite H3 slice) within remaining budget can give a directional read.

## Decision

Build the ablation harness + research backing now ($0). Run the empirical A/B/C proof when budget is allocated, honest numbers only, reporting H1–H4 verdicts (including backfire on hard code if observed). Drop-in, removable augmentation (ADR-150 constraint): ruvector is swapped in behind a memory-layer interface; the base cascade still runs without it.
