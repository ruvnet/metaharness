# ADR-181 — Multi-model, multi-benchmark cost-Pareto fleet

**Status:** Accepted / in progress
**Date:** 2026-06-23
**Related:** ADR-179 (leaderboard), ADR-180 (GCP+Firestore), ADR-150

## Context

The cost-Pareto thesis is strongest when shown across *many cheap models* and *many benchmarks*, not one.
We have the runner (ADR-180) and the public board (ADR-179) with 4 tabs (Lite, Verified, Pro, DRACO). Next:
measured Darwin numbers for several low-cost frontier models, and a roadmap of agentic boards.

## Decision

**Concurrent GCP fleet (cheap models, measured):** each model runs the interactive solver on a SWE split via
`gcp-swebench-runner.sh` (now `MODEL`-parameterized), gold-evals, writes to Firestore `darwin_runs`.
- `darwin-verified-runner` — DeepSeek-V4-Flash · Verified (500)
- `darwin-lite-glm` — GLM-5.2 · Lite
- `darwin-lite-kimi` — Kimi-K2.6 · Lite
- Qwen3-Coder-30B deferred: 32-vCPU region quota + it measured 0–4% in our scaffold (LEARNINGS §11, harness-specific).

**Quota notes (us-central1):** SSD-total = 500 GB (use `pd-standard` for extra VMs), CPUS = 32 (≤4× e2-standard-8).

**Agentic-board roadmap (staged — each needs its own harness, not just a model swap):**
1. SWE-bench **Multilingual / Multimodal** — reuse our swebench harness → lowest effort, next.
2. **Aider Polyglot** — multi-language edit, clean $/task → strong cost story.
3. **Terminal-Bench** — agentic terminal tasks, matches our ReAct loop.
4. **τ-bench** — tool-use/customer-service agent.
5. **GAIA** (3 levels) — repo already has `gaia-benchmark-runner` agents.
6. **LiveCodeBench** — contamination-free coding, $/problem.

Each board lands as another tab in `assets/swe-pareto.json`, scores blended by the same Value Score (ADR-179).

## Consequences

- A broad, measured "cheap-beats-frontier across models & domains" dataset, aggregated in Firestore.
- Real GCP cost (~$0.27/hr/VM + disk + model spend) — delete VMs after retrieval; respect region quotas.
- Honesty: models that underperform in our scaffold (e.g. Qwen3) are recorded as measured negatives, not hidden.
