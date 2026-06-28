# Empirical: ADR-201 H1 "knowledge-flattening" pilot — does dense-RAG lift cheap models *disproportionately*?

**ADR:** [ADR-201](../../../adrs/ADR-201-vector-memory-graphrag-cheap-model-lift.md) (vector-memory ablation)
**Hypothesis under test (H1):** vector RAG shifts the burden from parametric knowledge (the frontier's moat) to in-context synthesis (where cheap models punch up), so dense retrieval should lift cheap models **disproportionately** — i.e. **Retrieval Lift Δ_cheap > Δ_frontier**, where `Δ_model = resolve(+dense-RAG) − resolve(base, no-RAG)`.
**Evidence-grounded prediction (ADR-201):** +5–11 pp cheap lift, ~1.7× disproportionality (recalibrated down from the brief's +12–18).
**Date:** 2026-06-28. **Harness:** `packages/darwin-mode/bench/ruvector/h1-pilot.mjs` (+ `memory-layer.mjs` DenseMemory, `embedder.mjs`). **Total spend:** **$1.68** (lexical arm $0.86 + semantic robustness arm $0.81), within the +$15 authorization.

## Verdict (headline)

> **H1 is NOT supported.** Dense retrieval did **not** lift cheap models, and showed **no disproportionate cheap-model benefit**, in either retriever configuration tested.
> - With a **lexical** retriever, dense context **mildly hurt** every model (Δ deepseek −5.0pp, opus −7.5pp, gpt-5.5 0.0pp) — consistent with H2 context-distraction, not H1 flattening.
> - With a **semantic** retriever, cheap deepseek and opus were **flat** (Δ 0.0pp); the **only** gain accrued to a **frontier** model — gpt-5.5 +7.5pp (95% CI **includes 0**). That is the *opposite* direction to knowledge-flattening.
> - In no arm did the cheap model post a positive lift, so the disproportionality test (`Δ_cheap > Δ_frontier > 0`) fails on its first clause.
>
> The predicted +5–11pp cheap lift **did not materialize**. This is a genuine **null** (directional, underpowered at n=40), reported as-is.

## Design

- **Benchmark:** FRAMES (`google/frames-benchmark`) — the open, ungated GAIA-class multi-hop QA proxy. **n=40, seed 42** (deterministic subset of the prior FRAMES runs; **same 40 questions per model**).
- **2 conditions × 3 models × 40 = 240 cells** per retriever arm:
  - **(0) base, no-RAG** — parametric only; the model answers from its own knowledge.
  - **(1) +dense-RAG** — `DenseMemory` cosine retrieval over a per-question Wikipedia corpus, **k=8, ≤12k context tokens** (actual mean ≈1.4k tokens; 8 short passages).
- **Models (current frontier, verified on OpenRouter 2026-06-28):** cheap **`deepseek/deepseek-v4-pro`** ($0.43/$0.87 per Mtok); frontier **`openai/gpt-5.5`** ($5/$30) + **`anthropic/claude-opus-4.8`** ($5/$25).
- **Scorer:** GAIA `scorer.py`-style **strict normalized exact-match** (numeric → list → string pathways) — the same conformant scorer as the published FRAMES run. Relaxed match also recorded.
- **Stats:** per-cell **Wilson 95% CI**; per-model **Δ** with **paired bootstrap 95% CI** (10k resamples over the shared 40 questions); disproportionality via **bootstrap CI on Δ_cheap − Δ_frontier**.
- **Retriever robustness (two arms):** the scaffold ships a keyless **lexical** hashed-bigram embedder. Because a weak retriever could *by itself* produce a null (garbage context → distraction), the pilot was re-run with a real **semantic** embedder — ruvector's `OnnxEmbedder` (all-MiniLM-L6-v2, 384-d, local, $0). Both arms are reported.

### Conformance firewall (no gold leakage)
The per-question Wikipedia corpus is built from a keyless MediaWiki search keyed on the **question only** (full question + quoted phrases + capitalized proper-noun spans + code tokens). The gold `answer` is **never** used to search, fetch, chunk, embed, retrieve, or prompt — it is read in exactly **one** place: the offline scorer, after the model has already produced its prediction. Corpus = public English Wikipedia plaintext. Mean corpus 122.7 passages/q (min 18, max 195); all 40 corpora populated.

## Results — 3×2 resolve tables (strict EM)

### Arm A — lexical retriever (hashed bigram; the scaffold default)

| Model | Tier | base (no-RAG) | +dense-RAG | **Δ (lift)** | Δ 95% CI (bootstrap) | relaxed base→+dense | flips +→− / −→+ |
|-------|------|--------------|-----------|--------------|----------------------|---------------------|-----------------|
| deepseek-v4-pro | cheap | 10.0% [4.0, 23.1] | 5.0% [1.4, 16.5] | **−5.0pp** | [−15.0, +5.0] | 12.5→5.0% | 3 / 1 |
| gpt-5.5 | frontier | 10.0% [4.0, 23.1] | 10.0% [4.0, 23.1] | **0.0pp** | [0.0, 0.0] † | 10.0→10.0% | 0 / 0 |
| claude-opus-4.8 | frontier | 12.5% [5.5, 26.1] | 5.0% [1.4, 16.5] | **−7.5pp** | [−17.5, 0.0] | 15.0→5.0% | 3 / 0 |

† gpt-5.5's lexical Δ CI is [0,0] because the *same* 4 questions were correct in both conditions (zero flips) — a real outcome, not a bug.

### Arm B — semantic retriever (ONNX all-MiniLM-L6-v2, 384-d; robustness)

| Model | Tier | base (no-RAG) | +dense-RAG | **Δ (lift)** | Δ 95% CI (bootstrap) | relaxed base→+dense | flips +→− / −→+ |
|-------|------|--------------|-----------|--------------|----------------------|---------------------|-----------------|
| deepseek-v4-pro | cheap | 10.0% [4.0, 23.1] | 10.0% [4.0, 23.1] | **0.0pp** | [−12.5, +12.5] | 12.5→10.0% | 3 / 3 |
| gpt-5.5 | frontier | 10.0% [4.0, 23.1] | **17.5%** [8.7, 32.0] | **+7.5pp** | [−2.5, +17.5] | 10.0→20.0% | 1 / 4 |
| claude-opus-4.8 | frontier | 12.5% [5.5, 26.1] | 12.5% [5.5, 26.1] | **0.0pp** | [−7.5, +7.5] | 15.0→12.5% | 1 / 1 |

The semantic embedder is genuinely semantic (probe: cos(question, relevant fact) = 0.655 vs cos(question, irrelevant fact) = 0.013). It removes the lexical arm's distraction (deepseek/opus recover to flat) and lets gpt-5.5 convert context into answers — but the beneficiary is a **frontier** model.

![H1 pilot](../charts/08-h1-knowledge-flattening.svg)

## Disproportionality verdict (Δ_cheap − Δ_frontier)

| Arm | Comparison | Δ_cheap | Δ_frontier | ΔΔ = Δ_cheap − Δ_frontier | ΔΔ 95% CI | P(Δ_cheap>Δ_frontier) | H1 met? |
|-----|-----------|---------|-----------|---------------------------|-----------|-----------------------|---------|
| Lexical | deepseek vs gpt-5.5 | −5.0 | 0.0 | **−5.0pp** | [−15.0, +5.0] | 0.10 | ✗ |
| Lexical | deepseek vs opus-4.8 | −5.0 | −7.5 | +2.5pp | [−10.0, +15.0] | 0.58 | ✗ (mutual *degradation*, not lift) |
| Semantic | deepseek vs gpt-5.5 | 0.0 | +7.5 | **−7.5pp** | [−22.5, +5.0] | 0.11 | ✗ (reversed) |
| Semantic | deepseek vs opus-4.8 | 0.0 | 0.0 | 0.0pp | [−12.5, +12.5] | 0.42 | ✗ |

**H1 requires `Δ_cheap > Δ_frontier` AND `Δ_cheap > 0` (a real lift the cheap model captures more of).** The cheap model's Δ is ≤ 0 in every arm, so the second clause never holds; the lexical "deepseek vs opus" row only "passes" the first clause because *both* models degraded and the cheap one degraded slightly less — that is not knowledge-flattening. **No comparison reaches significance at 95%.** Conclusion: **H1 not supported; if anything, good retrieval helped the frontier model more (anti-flattening direction), though not significantly.**

## Base no-RAG row — the cheap-vs-CURRENT-frontier parametric gap

| Model | base resolve (strict EM) | Wilson 95% CI |
|-------|--------------------------|---------------|
| deepseek-v4-pro (cheap) | **10.0%** | [4.0, 23.1] |
| gpt-5.5 (frontier) | **10.0%** | [4.0, 23.1] |
| claude-opus-4.8 (frontier) | **12.5%** | [5.5, 26.1] |

On parametric single-shot FRAMES, **the cheap model matches current frontier**: deepseek-v4-pro ties gpt-5.5 to the decimal (10.0%) and is statistically indistinguishable from opus-4.8 (12.5%; CIs fully overlap). This complements the prior result (cheap ≈ frontier-from-months-ago on the *agentic* FRAMES axis) with a same-setup, **same-day cheap-vs-current-frontier** reading: **parity** even against today's frontier, at this floor-level single-shot difficulty.

## Honesty / limitations (read before citing)

1. **Floor-level absolute scores (10–12.5%).** This pilot is deliberately stripped down vs the prior agentic FRAMES run (which scored 37–43% with an 18-step ReAct loop, iterative Wikipedia browse, *and* reasoning). Here it is **single-shot** (one retrieval, one answer), **reasoning DISABLED**, strict EM. **Absolute numbers are not comparable** to that run; only the **within-setup Δ (base vs +dense)** is the H1 signal.
2. **Reasoning was disabled — and had to be.** With reasoning on, both reasoning models (deepseek-v4-pro, gpt-5.5) consumed the *entire* token budget on hidden reasoning and returned **empty** answers (verified: completion_tokens=1024, content=""), at ~40× the cost. Disabling reasoning is applied **uniformly** (all models, both conditions), so the Δ comparison stays fair — but it is plausible that reasoning-on would let models exploit retrieved multi-hop context differently. This is the single biggest caveat.
3. **n=40 → underpowered.** Every Δ CI includes 0; effects below ~10pp are not resolvable. This is a directional pilot, not a powered test.
4. **Single-shot RAG on multi-hop questions is intrinsically hard.** One retrieval pass over question-keyword Wikipedia rarely surfaces the *bridge* entity a multi-hop FRAMES question needs, which caps achievable lift regardless of model.
5. **Retriever-quality confound is bracketed, not eliminated.** The two embedder arms span lexical→semantic; both refute H1. A still-stronger retriever (reranking, multi-query, larger k toward the 12k budget) might change the picture, but would not rescue the *disproportionality* claim given the semantic arm already favors the frontier.

## H3 / H4 (ruvector GraphRAG) — DEFERRED

Per ADR-201 §ruvector-reality, **ruvector@0.2.32 does not ship a working GraphRAG path**: `@ruvector/graph-node` is not bundled (`CodeGraph.cypher()` throws, `isGraphAvailable()===false`), and the RVF query surface is degraded (`rvfStatus().totalVectors===1`, query returns ≤1 hit → the harness falls back to in-process cosine). Therefore **the "ruvector" arm ≡ the dense baseline at this version** and was **skipped** as instructed. **H3 (GraphRAG > dense) and H4 (GNN epoch self-learning) remain deferred** until ruvector ships working GraphRAG + multi-vector RVF query (or a working version is pinned). The memory-layer seam is real and will measure graph lift the moment the capability lands.

## Reproduce

```bash
cd packages/darwin-mode/bench/ruvector
# manifest (n=40, seed 42): node ../gaia/frames-loader.mjs --sample 40 --seed 42 --out "$PWD/data/manifest-frames-n40.json"
# lexical arm:
node h1-pilot.mjs --manifest data/manifest-frames-n40.json \
  --models deepseek/deepseek-v4-pro,openai/gpt-5.5,anthropic/claude-opus-4.8 \
  --k 8 --max-context-tokens 12000 --meter --max-cost 15 --abort-usage 2620 \
  --out data/h1-preds.jsonl --report data/h1-report.json
# semantic robustness arm: add --embedder onnx (writes data/h1-*-onnx.*)
# chart: node ../../../../docs/research/cheap-vs-frontier/make-h1-chart.mjs
```

Artifacts: `data/h1-report.json`, `data/h1-preds.jsonl` (lexical); `data/h1-report-onnx.json`, `data/h1-preds-onnx.jsonl` (semantic); per-question corpora in `data/corpus-cache/`.
