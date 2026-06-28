# Optimal Applications for ruvector — Discovery + Proof

**Date:** 2026-06-28 · **Method:** local benchmarks (Ryzen 9 9950X) + published-SOTA comparison + empirical LLM ablations, all $0 except the LLM runs. Every claim links to a proof doc with real numbers.
**One-line answer:** ruvector's optimal applications are **(1) COW vector snapshot/lineage checkpointing** and **(2) an embedded GraphRAG / agent-memory retrieval substrate** — NOT raw vector-search speed (3-5× behind SOTA) and NOT augmenting cheap LLMs on everyday work (structurally null).

---

## The ranked verdict (with proof)

| Rank | Application | Verdict | Proof |
|------|-------------|---------|-------|
| **1. OPTIMAL (novel)** | **RVF COW snapshot / lineage checkpointing** | Genuine SOTA-unique differentiator | `RVF-COW-PROOF.md` |
| **2. OPTIMAL (niche)** | **Embedded GraphRAG / agent-memory substrate** (graph adjacency + vector-kNN in one binary) | Best-in-class for *shallow* hybrid retrieval | `GRAPH-ANALYTICS-PROOF.md` |
| 3. MARGINAL | Raw ANN vector search | Works, but ~3-5× behind SOTA | `VECTOR-SEARCH-PROOF.md` |
| 4. NULL | RAG-augmenting cheap LLMs (dense/graph) | Structurally null on everyday QA | `empirical/VECTOR-MEMORY-{H1-PILOT,H3-RESULTS}.md` |
| 5. CONDITIONAL | Confidence-based model routing (hard axis) | The one live LLM lever — needs confidence signal + a real gap | `empirical/ROUTER-PILOT.md`, `SELF-LEARNING-RAG-SOTA.md` |

---

## 1. OPTIMAL — RVF COW snapshot/lineage (the genuine differentiator)
**Proven:** branch *creation* is cheap and **base-size-independent** — `derive()` = 0.47-0.78ms / 162-byte branch, **flat from 10k→1M base**, vs full-copy 64.7ms/496MB at 1M → **~83× faster, ~3000× smaller**. No mainstream vector DB (faiss/hnswlib/qdrant) has native COW branching; prior art (lakeFS/DVC/Delta-time-travel) is data/table-level, not vector-index-native. **This is the one place ruvector is provably novel.**
**Use cases:** per-experiment index snapshots, agent-memory checkpoints, A/B index states, cheap rollback.
**Caveat (proven + filed):** through the Node API a child is a *lineage delta*, not a queryable parent∪edits union (read-through `CowEngine` exists but isn't wired to the query path; `branch()` unexposed). Market as snapshot/lineage today; **fix candidate** to make it queryable. README perf claims partially overstated (2.5MB→51KB; 125ms→242ms@1M; 12µs→174-316µs e2e).

## 2. OPTIMAL — embedded GraphRAG / agent-memory substrate
**Proven:** kHop neighborhood **~0.015ms / 67k qps, scale-invariant 10k→50k** + first-class **vector-kNN over hyperedges**, in one embedded binary. That *combination* is the differentiator — exactly what an agentic-memory or hybrid graph+vector retriever needs.
**Use cases:** agent long-term memory, hybrid structural+semantic retrieval, code/entity graphs with embeddings.
**NOT for:** Cypher OLAP (only `MATCH (n:Label)` works; relationship patterns/WHERE/aggregation return empty) or graph algorithms (pageRank/shortestPath/centrality absent). **Bug found + FIXED upstream:** batchInsert nodes were missing from the label index → **PR #616** (ruvnet/RuVector).

## 3. MARGINAL — raw ANN vector search
**Proven NOT SOTA:** SIFT-1M HNSW 0.97 recall @ 1,252 QPS; **hnswlib-node ~2.7× faster same-machine**, SOTA ~6-12k QPS @ 0.97 → **3-5× behind**. RaBitQ flat 1-bit recall **0.133** (no IVF layer; paper's 99.3% needs IVF-RaBitQ, absent). Root cause: pure-Rust `hnsw_rs` lacks SIMD intrinsics, sequential insert (30× build overhead). Scaffolding correct, performance engine under-powered. **Don't choose ruvector for vector-search speed.**

## 4. NULL — RAG-augmenting cheap LLMs (everyday QA + code)
**Proven null four ways:**
- FRAMES (everyday, gpt-5.5/opus-4.8 frontier): dense RAG (H1, Δ≤0 for cheap), kHop-graph (H3, structural: kHop+cosine≡dense on a dense corpus, graphHits=0), routing (H5, chance accuracy).
- **Code axis (SWE-bench, n=29, $0.09):** the graph **did traverse this time** (graphHits>0 on 5/5 repos; topology recovered 2/2 gold files dense cosine ranked 52-62) — so the FRAMES collapse didn't recur. BUT as a **standalone** retriever it's **NOT SUPPORTED**: gold-localization@3 Δ = −6.9pp (deepseek) / +3.4pp (glm), CIs overlap; topology had *lower* set-recall (59% vs 76%) and *more* tokens (Cr=−0.14) — PageRank surfaces hubs, not fix-files.

**Two structural reasons, SOTA-confirmed:** (a) on everyday work cheap models are *already at parity* with frontier → no headroom; (b) the context-utilization ceiling — sub-7B-class API models fail to use even *oracle* context 85-100% of the time, RAG overturns 42-64% of correct answers (arXiv 2603.11513), curable only by RAG-aware *fine-tuning* (needs weights, N/A for API). Also: the "code is cosine-sparse" premise was **falsified** — file-level code under MiniLM is *denser* than FRAMES (median 0.48 > 0.434); graph traversal works via *topology*, not embedding sparsity.

**The one un-refuted retrieval hope:** a **hybrid (dense ∪ graph) retriever on the large-repo tail**, where dense recall genuinely fails (e.g. pgmpy/pdm, gold at dense-rank 52-62). Under-sampled here; needs a powered n≥100 large-repo Docker-resolve run (own budget) to confirm or kill.

## 5. CONDITIONAL — confidence-based routing (the one live LLM lever)
Routing is the *only* black-box self-learning intervention with high SOTA evidence (RouteLLM 40%@95%, OrcaRouter, UCCI) — but our embedding-kNN router scored at **chance** (difficulty isn't encoded in the query embedding). The fix per SOTA: route on the cheap model's **own confidence/logprobs**, and only where a **cheap≠frontier gap exists** (hard/code axis, not parity-everyday). *Open:* the code-axis test (sparse code graph, where retrieval/routing could finally be non-null).

---

## Bottom line
ruvector's *honest* optimal applications are **infrastructure primitives** — COW snapshot/lineage (novel, SOTA-unique) and embedded graph+vector retrieval substrate (niche-best for shallow hybrid retrieval) — **not** the headline "make cheap LLMs as good as frontier via RAG" (structurally null on everyday work *and* code, four ways) **nor** raw ANN speed (3-5× behind SOTA). The only un-refuted LLM angles, both narrow and unproven-at-power: **confidence-routing on a real cheap≠frontier gap**, and a **hybrid dense∪graph retriever on the large-repo tail**. Bugs found + fixed by this sweep: graph-node batchInsert (**PR #616**) + RVF COW read-through (filed). The discovery did what was asked: it found where ruvector is genuinely optimal (infra), proved where it isn't (RAG-for-cheap-LLMs, ANN speed), and shipped a real upstream fix — honest numbers throughout, including a self-caught invalidated run (deepseek empty-response artifact) that was re-run clean.
