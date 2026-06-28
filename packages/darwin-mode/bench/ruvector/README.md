# ADR-201 — ruvector vs dense-RAG ablation harness (Phase 0 scaffold)

Tests whether vector/graph memory lifts **cheap** models over the turn-budget cliff
(ADR-201, `docs/adrs/ADR-201-vector-memory-graphrag-cheap-model-lift.md`).
This directory is the **Phase 0** build: the plumbing for a later, budget-gated
A/B/C × 2-epoch empirical run. It runs and self-validates at **$0**.

Augmentation is **removable** (ADR-150): everything sits behind the `MemoryLayer`
interface in `memory-layer.mjs`. The base cascade still runs on `DenseMemory` alone;
ruvector is a drop-in/drop-out.

---

## Ground-truth: REAL `ruvector@0.2.32` API surface (verified 2026-06-28)

The ADR brief's code sample imported from `'ruvnet'` — **wrong**; the package is
**`ruvector`**. Probed the actual native build (`getImplementationType() === 'native'`).
What is **shipped** vs **stub/absent** at this version:

| Capability (ADR-201 claim) | Status at 0.2.32 | Real API |
|---|---|---|
| **`.rvf` persistent store + COW lineage** | ✅ **SHIPPED** | `createRvfStore / openRvfStore / rvfIngest / rvfQuery / rvfDelete / rvfStatus / rvfCompact / **rvfDerive** (COW child) / rvfClose`. `isRvfAvailable() === true`. |
| **GNN module** | ✅ present | `isGnnAvailable() === true`; `gnnWrapper`, `gnn`. |
| **Vector DB / HNSW** | ✅ SHIPPED | `VectorDB`/`VectorDb`/`VectorIndex`, `DiskAnnIndex`, `cosineSimilarity`. |
| **Self-learning / feedback** | ⚠️ **PARTIAL — different shape** | No graph `memory_feedback` edge-reweight. Shipped as **RL episode recording**: `IntelligenceEngine.{recordEpisode, recordRouteOutcome, learnFromSimilar, forceLearn, recordErrorFix}` + `LearningEngine.{qLearningUpdate, sarsaUpdate, ppoUpdate, decisionTransformerUpdate, …}`. |
| **GraphRAG / Cypher retrieval** | ❌ **NOT SHIPPED (stubbed here)** | `CodeGraph` exists with `.cypher / pageRank / shortestPath / communities`, **but** instantiating it throws `@ruvector/graph-node not installed` (not bundled). `isGraphAvailable() === false`. |
| **Embedding providers (keyless)** | ❌ **stubs at 0.2.32** | `MockEmbeddingProvider` returns `[[]]`; `LocalNGramProvider` returns a length-1 vector. `EmbeddingService`/`OnnxEmbedder` work but pull an ONNX model. → We ship our own keyless embedder. |

### Two quirks that shape the harness

1. **RVF multi-vector persistence is broken at this dep version.** `rvfIngest` reports
   `accepted: N` but `rvfStatus().totalVectors === 1`, and `rvfQuery` returns ≤1 hit
   (positional id `"0"`) regardless of batch size or one-by-one ingest. So **RVF cannot
   be the live ANN index yet.** `RuvectorMemory` therefore uses RVF for **persistence +
   COW lineage** (which work) and **falls back to in-process cosine over the authoritative
   doc table** for ranking, flagged `rvfDegraded: true`. Marked `TODO[rvf-query]` — drop
   the fallback when native multi-vector query is fixed.
2. **RVF query returns remapped ids** (not the canonical id ingested). `RuvectorMemory`
   keeps an ingest-order map + canonical doc table to resolve payloads. `TODO[rvf-id]`.

### What this means for ADR-201

- **H3 "GraphRAG > dense"** cannot be tested as *graph* retrieval at 0.2.32 — GraphRAG is
  absent. The harness exposes `graphrag: true` on `RuvectorMemory`, currently a
  `[GRAPHRAG-STUB]` that routes to vector kNN; when `@ruvector/graph-node` ships, wire
  `CodeGraph.cypher` in `RuvectorMemory.query()`.
- **H4 "GNN self-learning"** is implemented as **reward-rerank** feedback (a faithful,
  shipped approximation persisted across the RVF COW branch). `TODO[gnn-feedback]`: swap
  in graph edge-reweight when available.
- Honest consequence: **at 0.2.32, ruvector provides no retrieval *lift* over dense**
  (same embedder + same docs + degraded RVF query). The harness is built to *measure*
  lift the moment a ruvector version with working RVF query + GraphRAG lands.

---

## Files

| File | Role |
|---|---|
| `memory-layer.mjs` | The seam. `DenseMemory` (in-proc cosine, $0, dep-free) + `RuvectorMemory` (real RVF + COW; GraphRAG stubbed). `makeMemory(kind, opts)`. |
| `embedder.mjs` | Keyless deterministic hashed-bigram embedder + cosine + token estimate. Shared by both arms so A/B isolates the *index*, not the embedding model. |
| `telemetry.mjs` | Pure ADR-201 math: Retrieval Lift Δ, Compression Cr, Turn-Budget Survival S_T, Cost-Adjusted Lift L_C, Context-Degradation knee, Wilson CI. No I/O → unit-tested. |
| `ruvector-eval.mjs` | A/B/C runner. Control A (dense, hard bail) / Test B (ruvector, static bail) / Test C (ruvector, dynamic bail @ τ). Emits all telemetry; per-task preds exfil. |
| `warmup-epoch.mjs` | H4 protocol: Epoch0 → solve-outcome feedback → RVF COW branch → Epoch1 → Wilson-CI verdict. Per-instance isolation + persistent reward map. |
| `exfil.mjs` | Per-task pred exfil mirroring the FRAMES/cve-bench Firestore REST pattern. **Default = local JSONL ($0/no-GCP)**; `--exfil` also POSTs to Firestore via `gcloud` token. |
| `synthetic.mjs` | $0 offline fixtures: deterministic RAG-QA manifest + mock LLM + answer normalizer. |
| `tests/` | `telemetry.test.mjs` (10) + `dense-memory.test.mjs` (9). Dep-free — no ruvector needed for CI. |

## Conformance firewall

`feedback()` consumes **solve outcomes** (`resolved: boolean` from the harness's own
test signal) — there is **no gold parameter**. Synthetic gold answers live in the
**corpus** (what RAG is allowed to read); the separate `task.answer` is used only by the
offline scorer, never placed in a prompt or in feedback.

---

## Run

### $0 self-validation (no network, no GCP) — what proves the plumbing

```bash
# unit tests (dense baseline + telemetry math) — 19 tests, dep-free
node --test tests/telemetry.test.mjs tests/dense-memory.test.mjs

# mocked end-to-end A/B/C dry-run (proves wiring + Cr/Δ/S_T/L_C compute)
RUVECTOR_PATH=/path/to/ruvector@0.2.x \
  node ruvector-eval.mjs --arm all --synthetic 12 --mock --k 5 --concurrency 2 \
  --out /tmp/preds.jsonl --report /tmp/report.json

# mocked warm-up epoch (proves Epoch0→feedback→COW branch→Epoch1→verdict)
RUVECTOR_PATH=/path/to/ruvector@0.2.x \
  node warmup-epoch.mjs --synthetic 20 --mock --kind ruvector --k 2 --report /tmp/wu.json
```

`RUVECTOR_PATH` must point at a **ruvector@0.2.x** install (the RVF surface; 0.1.x lacks
`rvf*`). If unset, the loader tries `ruvector` then known local paths. Set `RVF_DIR` if
your `/tmp` rejects `fsync`. Arm A (dense) needs **no** ruvector at all.

### Paid, BUDGET-GATED A/B/C × 2-epoch run (NOT run in Phase 0)

```bash
OPENROUTER_API_KEY=$KEY node ruvector-eval.mjs --arm all \
  --manifest <frames-or-swebench-manifest>.json \
  --model deepseek/deepseek-v4-pro --escalate anthropic/claude-opus-4 \
  --k 8 --max-context-tokens 12000 --concurrency 4 --tau 0.35 \
  --max-cost 5 --out preds.jsonl --report report.json --exfil
```

Manifest shape: `{ "tasks": [{ "id", "question"|"problem", "answer", "corpus": [{"id","text"}] }] }`.

## Budget gate

Phase 1 (the real A/B/C × 2-epoch proof: SWE-bench × 3 swarms × 2 epochs) is
**expensive and gated on a new budget allocation** — it does **not** run from this
scaffold automatically. `--max-cost` is a per-process soft cap; the authoritative gate is
the **OpenRouter account meter** (see `cve-bench/gcp-cascade-dispatch.mjs` §56: Opus
undercounts ~1.7× on OpenRouter, so the account `auth/key.usage` delta is the real fence,
not the in-process tally). Do not launch a paid run without an explicit allocation.

### Estimated cost of the future paid run

- Per-cell (one model × one task, RAG-augmented, ~8 ctx passages, hard-bail): ≈ **$0.15**
  agentic-equivalent (matches the SWE-bench cascade `~$0.15/instance` figure).
- **Minimal FRAMES H1 pilot** (n=40 × 2 models × {base, +dense, +ruvector}): ~240 cells,
  FRAMES cells are cheap QA (~$0.01–0.03 each) → **≈ $5–10**.
- **Full hard-code A/B/C × 2-epoch** (SWE-Lite n=150 + Pro n=50 × 3 arms × 2 epochs):
  ~1,200 instance-runs × ~$0.15 → **≈ $180** order-of-magnitude — well beyond the ~$35
  cheap-vs-frontier remainder; needs its own allocation.
