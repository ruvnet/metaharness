# ADR-195 — Phase-2 capability stack: localization, reproduction-gate, reviewer (the new-code harness investments)

**Status:** Proposed (diagnosis-gated build queue)
**Date:** 2026-06-26
**Related:** ADR-194 (crack-the-tail: per-instance evolution → generalizable capabilities → conformant validation), ADR-153 (agentic-loop architecture for the 65-88% tier), ADR-176 (SWE Conductor — role-specialized localize/repro/fix/review), ADR-190 (AST-fused mincut localization, declined for the cheap cascade), ADR-175 (Test-Driven Repair), RuVector (`ruvector-core` HNSW, `ruvector-gnn-rerank`, `ruvector-mincut`). LEARNINGS §44/§49/§50 + the HARD-25 1-3/25 signal.

---

## Context

The ADR-194 per-instance evolution searches a **Phase-1 genome** — model, mode (single/cascade/xbo/bo3), escalation model, BoN width, turn budget, temperature, system-prompt variant — all **config-toggleable today**. Phase-1 is largely exhausted on the hard tail: only Best-of-N beats single-Opus (§50), and frontier BoN cracks just **1-3 of the 25 Opus-give-ups**. The instances that resist *every* Phase-1 allele fail for **structural** reasons that no config toggle can fix.

Those reasons require **new solver code** — they are not genome toggles yet. This ADR specs the three Phase-2 capabilities, in the order the diagnosis is expected to demand them, so the build is a queue, not a guess.

## Decision

Build three capabilities as new solver code, each then exposed as a Phase-2 genome gene (so per-instance evolution can re-measure coverage lift), prioritized by the ADR-194 coverage map (build the one that cracks the most still-uncracked instances first).

### 1. Localization (expected #1 blocker) — RuVector-powered
The agent never finds the right files in large repos. Build retrieval-seeded localization:
- Chunk repo source (function/class granularity) → embed with a code-capable model → **`ruvector-core` HNSW** index → retrieve top-k issue-relevant chunks → optional **`ruvector-gnn-rerank`** (score-diffusion reranking recovers recall) → inject as the agent's starting file surface. Optionally **`ruvector-mincut`** (ADR-190 AST-mincut, revisited — it was declined for the *cheap* cascade because §38 showed localization wasn't the cheap bottleneck, but the hard tail is exactly where it matters).
- This is the leaders' biggest lever (retrieval ~doubles entity recall). RuVector supplies the index/rerank engine; new code = chunking + code-embeddings + seed injection into `solve-agentic`. Conformant (repo code + issue text only).

### 2. Reproduction-first gate
The agent can't verify a fix it can't reproduce. Build a **repro-first loop**: write a failing `reproduce_bug.py` from the issue, run it in the conformant base env (deps present, NO gold tests), iterate the patch until the self-written repro passes. This is the conformant analog of TDR's 68.3% lever (ADR-175); §44 showed a *weak* repro-gate is moderate, so the investment is a *stronger* repro generator + execution loop, not the gate alone.

### 3. Reviewer / critic sub-agent
A second agent reviews the candidate patch (correctness, regressions, scope) and drives a bounded revision loop (ADR-176 SWE Conductor's review role). New code = the review/revise loop around the existing solve.

## Consequences
- This is the **ADR-153 capability stack, built incrementally and diagnosis-driven** — each capability is justified by the instances it cracks, measured by re-running per-instance evolution with the new gene, then validated as ONE conformant harness on **held-out n=300** (ADR-194 firewall: per-instance gold-tuning is diagnosis only, never a claim).
- **Sequencing is gated on the diagnosis**, not assumed — though localization is the strong prior (dominant blocker + RuVector-ready). Build → re-crack → measure lift → next capability.
- **Honest ceiling** (ADR-194): some Opus-give-ups are under-specified or have non-unique gold patches; the hard-25 ceiling is below 25/25. Recognizing the uncrackable set is part of the result.
- Cost shape: the *builds* are $0 engineering; only the re-crack + held-out validation runs cost OpenRouter, gated by the ADR-072 breaker.
