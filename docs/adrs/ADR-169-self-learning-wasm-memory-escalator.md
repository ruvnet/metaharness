# ADR-169: Self-learning WASM-memory cost-optimal escalator (E2/E3/E4)

**Status**: Implemented — cores + tests ($0, offline); empirical at-scale runs deferred (budget)
**Date**: 2026-06-21
**Project**: `ruvnet/agent-harness-generator`
**Related**: research `docs/research/2026-06-21-self-learning-wasm-memory-escalator.md`; ADR-148/152
(tiering), ADR-153 (agentic loop), ADR-154 (58.3% 3-tier). Incorporates an external peer review.

## Context

The single-shot + repair + N-tier escalation paradigm reached a verified **58.3%** on SWE-bench Lite
(ADR-154) at ~$0.74/instance blended. The next gains are about **resolve-rate-per-dollar** and making
runs **compound**, not another fixed tier. The research report proposed five experiments; this ADR
implements the three that are buildable + verifiable at **$0** today, with the paid eval (E1/E5)
deferred until budget is available. The optimization objective is explicitly **cost-per-resolve**, and
SWE-bench Lite (our number) is kept strictly separate from Verified (leaderboard) — no vanity metrics.

## Decision — three $0 cores, each with the peer-review mitigation baked in

### E3 — Persistent patch memory so runs compound (`bench/swebench/patch-memory.mjs`)
Retrieve prior **resolved (issue → patch)** pairs and inject as few-shot exemplars. Deterministic,
dependency-free BM25 core ($0, WASM-portable); optional dense rerank via an **injectable** embedder
(ONNX MiniLM in the WASM kernel later — not wired to a paid model here).
- **Mitigation (negative transfer).** MiniLM clusters by NL topic, not code structure, so an
  irrelevant exemplar *degrades* the agent. `retrieveHybrid` blends `0.6·cosine + 0.4·BM25` and applies
  a **hard gate** (`minCosine`, `minScore`); `injectExemplars` returns **`''` — inject nothing** when
  nothing clears the gate. Verified by `inject nothing rather than negative transfer` tests.
- Corpus: `patch-memory-corpus.json` — the 175 resolved 3-tier patches (built disjoint; per-instance
  `excludeId` prevents self-retrieval). Wired into `solve-repair.mjs` as `--patch-memory <corpus>
  [--pm-k --pm-min-score]`.

### E2 — Learned difficulty router for cost-optimal escalation (`bench/swebench/difficulty-router.mjs`)
Predict P(cheap tier resolves) and escalate only the low-probability tail → cut frontier spend at equal
resolve.
- **Mitigation (p ≫ N overfit).** With ~300 labels we do **NOT** feed a raw 384-D embedding. We use
  **6 interpretable scalar features** (log issue length, code-block / traceback / file-path / identifier
  counts, repo prior), **z-score standardize**, and train an **L2-regularized** logistic regression
  with a strong default λ (bias unregularized). Tests assert it learns a separable signal AND that
  stronger L2 shrinks the weight norm.

### E4 — Anti-thrash for the extended agentic loop (`bench/swebench/agentic-loop.mjs`)
- **Mitigation (tool-thrash on max-30).** Each `read`/`grep`/`ls` (action→observation) state is FNV-1a
  hashed; on an exact repeat we append a system warning ("you already ran this exact action … change
  strategy or terminate") and count `thrash`. Keeps the $0.08/inst projection realistic by preventing
  infinite navigation loops. Verified by the `warns + counts thrash when the model repeats` test.

## What is NOT done here (budget-gated)
- **E1** (full-300 agentic on v4-pro, ~$50) and **E5** (agentic + Scholar hybrid, ~$150) require
  OpenRouter spend; the current key is exhausted ($497.55/$500). These remain the highest-ROI *paid*
  next steps — E1 also generates the trajectory dataset for future policy learning.
- A real ONNX-MiniLM embedder in the WASM kernel (the dense half of E3) — the seam (`buildIndex({embedder})`)
  is in place + tested with a stub; wiring the real model is follow-up.

## Consequences
Patch memory + difficulty routing + anti-thrash are now shipped code behind opt-in flags, each
unit-tested offline, none changing default behavior until enabled. The moment budget is available the
paid eval (E1 → E3 patch-memory delta → E5 hybrid) can run and batch-verify per the established
discipline (only batch-eval numbers are authoritative). Thanks to the external reviewer for the three
mitigations above — each is implemented and tested, not just noted.
