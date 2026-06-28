# RVF COW Branching — Proof / Refutation

**Question:** Is ruvector's RVF format (COW snapshot / branch) an optimal, differentiating
application — and do the README performance claims hold?

**Method:** $0 local benchmark. No LLM, no paid API. Real measurements against the
prebuilt node binding `npm/packages/rvf-node/rvf-node.linux-x64-gnu.node`
(`RvfDatabase.create / ingestBatch / query / derive`) from the local repo
`/home/ruvultra/projects/ruvector`.

**Machine / config:** AMD Ryzen 9 9950X (16C/32T), 124 GB RAM, Node v22.22.2, Linux 6.17.
Vectors: dim **128**, metric **cosine**, random `f32` in [-1, 1]. k=10 queries.
Benchmark scripts: `rvf-cow-bench.js`, `rvf-1m-probe.js` (in session scratchpad; methodology reproduced below).

---

## TL;DR verdict

| | |
|---|---|
| **Cheap, base-size-independent branch creation** | ✅ **PROVEN.** 162-byte empty branch and ~0.5 ms `derive()` are *constant* from 10k→1M base vectors. Naive full-copy scales linearly (0.97 ms → 64.7 ms). Genuinely sublinear — O(edits), O(1) in base. |
| **Genuine *git-like COW* (query a branch as parent ∪ edits)** | ❌ **NOT functional through the public API.** `derive()` produces a **lineage/provenance delta**, not a queryable COW union. The child does **not** read through to parent vectors. |
| **"1M vectors, 100 edits = ~2.5 MB branch"** | ⚠️ **Not reproduced** — measured **51 KB** (50× smaller), but smaller *because* the branch holds only the new vectors, not inherited parent clusters. |
| **"single .rvf boots in 125 ms"** | ⚠️ **Size-dependent.** 1.0 ms (10k) / 20.8 ms (100k) / **242.6 ms (1M)** — exceeded ~2× at 1M. |
| **"12µs warm queries"** | ❌ **Refuted as an end-to-end query number.** Measured node end-to-end k=10 p50 = **173.9 µs (10k) / 315.9 µs (100k)**. 12 µs is not an end-to-end k-NN figure. |
| **New finding: 1M HNSW build cliff** | ❌ First query on a freshly-opened 1M store (lazy HNSW build) **did not complete in 14 min** single-threaded; sub-second at 100k. |

**Bottom line:** The *differentiator is real but partial.* Cheap, correct, base-independent
branch/snapshot creation is proven and is genuinely novel in the vector-DB space (no faiss/
hnswlib/qdrant equivalent). But the headline "git-like COW branching" **overstates what is
wired end-to-end**: through the node binding a branch is a provenance-tracked delta that holds
only its own edits — you cannot query it as a union of parent + edits. The real cluster-level
COW engine exists in Rust but is unexposed and not connected to the query path.

---

## Measured numbers

All figures are real, from the runs above. Branch sizes/latencies marked *(const)* were
verified identical across base sizes.

| Base N | Base file | Build | Cold `open()` (p50) | Warm query k=10 (p50) | `derive()` empty | Empty branch | 10-edit branch | 100-edit branch | 1000-edit branch | Naive full copy (p50) |
|-------:|----------:|------:|--------------------:|----------------------:|-----------------:|-------------:|---------------:|----------------:|-----------------:|----------------------:|
| 10 000 | 4.96 MB | 14 ms | **1.02 ms** | **173.9 µs** | 0.48 ms | **162 B** | 5 801 B (5.7 KB) | 52 602 B (51.4 KB) | 520 603 B (508 KB) | 0.97 ms |
| 100 000 | 49.59 MB | 101 ms | **20.8 ms** | **315.9 µs** | 0.47 ms | **162 B** | 5 801 B *(const)* | 52 602 B *(const)* | 520 603 B *(const)* | 9.45 ms |
| 1 000 000 | 495.93 MB | 1003 ms | **242.6 ms** | n/a¹ | **0.78 ms** | **162 B** | *(const)* | *(const)* | *(const)* | **64.7 ms** |

¹ Warm query unmeasurable at 1M: the first query triggers a lazy HNSW index build that did
not return within **14 minutes** single-threaded (99.9% CPU the whole time). At 100k the first
query was sub-second. This is a superlinear index-build cliff, reported as its own finding.

Branch delta is a pure function of edit count, ≈ **520 B per edited vector** (128 f32 = 512 B
payload + framing), with **zero dependence on base size**.

---

## Claim-by-claim

### Claim 1 — "Git-like COW branching — 1M vectors, 100 edits = ~2.5 MB branch"

**Branch creation is cheap and sublinear: PROVEN.**
- Empty branch = **162 bytes** at 10k, 100k *and* 1M. `derive()` latency 0.47–0.78 ms, flat.
- 100-edit branch = **51.4 KB** at every base size. The delta tracks edits only, not base.
- Naive full copy scales with the base: 0.97 ms / 9.45 ms / **64.7 ms** (4.96 / 49.6 / 496 MB).
- At 1M: branch is **~83× faster** (0.78 ms vs 64.7 ms) and **~3000× smaller** (162 B vs 496 MB)
  than copying. This advantage *widens* with base size — the textbook COW win.

**The "~2.5 MB" figure: NOT reproduced.** Measured 100-edit branch = **51 KB**, ~50× smaller.
But it is smaller *because the branch does not inherit/reference parent clusters* — it stores
only the 100 new vectors. The 2.5 MB number (cluster-granularity copy) would only apply to the
unexposed `branch()` path (see Architecture below), not to the `derive()` the binding ships.

> **Verdict: the cheap/sublinear branch is REAL and better-than-claimed in raw bytes — but it
> is a lineage delta, not the COW union the wording implies.** See the critical caveat next.

### CRITICAL CAVEAT — the branch is not a queryable COW union

A "git-like COW branch" should let you query the child and see **parent data + your edits**.
It does not, through the node binding:

- Built a 5000-vector base, `derive()`d a child, ingested **1 new edit**, then **queried the
  child for a known *base* vector**. Top hit = the **edit** (`id=999999`), **not** the base
  vector. Base data is invisible to the child.
- The child's segments contain **no `COW_MAP`** and **no parent-cluster references** — only a
  98-byte manifest (parent pointer) plus the child's own `VEC` segment.
- Reopened standalone, the child reports `totalVectors = <edit count>` only.
- Parent isolation *does* hold: edits to the base after `derive()` are not seen by the child. ✅
- Lineage metadata is correct: `parentId`, `parentHash`, `lineageDepth = parent+1`. ✅

So `derive()` = **provenance-tracked empty delta store**, not a copy-on-write overlay.

### Claim 2 — "single .rvf boots in 125 ms"

**Size-dependent; exceeded at scale.** Pure data `open()` p50: **1.0 ms (10k) / 20.8 ms (100k)
/ 242.6 ms (1M)** — linear in file size (open loads vectors into memory). The 125 ms budget
holds comfortably to a few hundred-K vectors but is **~2× over at 1M**.

Caveat in fairness: the README's 125 ms is specifically "boots **as a microservice** — data +
code + lineage" (kernel/eBPF cognitive-container boot), which this benchmark did not exercise.
The numbers above are honest *data-open* latencies, the relevant figure for "open a .rvf and query".

### Claim 3 — "12µs warm queries"

**Refuted as an end-to-end query number.** Measured node end-to-end k=10 p50 = **173.9 µs (10k)
/ 315.9 µs (100k)** (queries use the HNSW index, recall@10 ≥ 0.95 contract). 1M not measurable
(build cliff). For reference, the README's own closest figures are **18.9 µs (k=1) / 25.2 µs
(k=10)** p50 from a small-dataset Rust criterion microbench, and **12.0 ns** is a single SIMD
dot-product distance op (128D) — neither is an end-to-end k-NN query through the binding. The
node end-to-end path is **~7–13×** slower than the Rust microbench (NAPI overhead + larger sets).

---

## Architecture: why the branch is lineage-only (root cause)

There are **two** derivation methods in `crates/rvf/rvf-runtime/src/store.rs`:

1. **`derive(path, DerivationType, opts)`** (line ~2005) — what the node binding's `derive()`
   calls (`crates/rvf/rvf-node/src/lib.rs:740`, with `DerivationType::Filter`). Creates the
   child with `cow_engine: None`, an **empty** vector set, and only records
   `parent_id / parent_hash / parent_path / depth+1`. No cluster inheritance.

2. **`branch(path)`** (line ~1916) — the *real* COW branch. Calls `derive()` then wires
   `cow_engine = Some(CowEngine::from_parent(...))` (all clusters → `ParentRef`) plus a
   `MembershipFilter` listing parent vector ids. **This is not exposed in the node binding.**

The genuine cluster-level engine `crates/rvf/rvf-runtime/src/cow.rs` (`CowEngine`) does
implement real COW: `ParentRef` read-through with chain following, write coalescing (copy
parent slab once, apply buffered mutations), and `CLUSTER_COW` / `CLUSTER_DELTA` witness events.
**But its `read_vector` / `read_cluster` are never called from the store query path** —
`read_path.rs` contains zero cow/parent references, and `query_exact` / the index path scan
only the local `self.vectors`. `cow_engine` / `membership_filter` are consulted *only* to
*disable* the index/RaBitQ fast paths (`store.rs:551`, `:466`), never to merge parent data.

Even the integration test named `branch_inherits_vectors_via_query`
(`crates/rvf/tests/rvf-integration/tests/cow_branching.rs`) asserts only that the
**`MembershipFilter` contains the ids** — it never runs a `query()` to verify read-through.
The COW unit tests in `cow.rs` exercise `ParentRef` reads in isolation, disconnected from the
public query API.

**Conclusion:** queryable COW (parent ∪ edits) is implemented at the cluster level in Rust but
is (a) not exposed to the node binding and (b) not wired into the store query path even for
`branch()`. What ships end-to-end is cheap lineage/snapshot deltas.

---

## SOTA framing & comparable prior art

No mainstream vector DB has git-like branching of a live ANN index:
- **faiss / hnswlib** — in-memory index, no native snapshot/branch; you serialize and copy.
- **qdrant** — collection snapshots exist, but they are **full copies**, not COW deltas, and
  there is no parent∪child read-through branch.
- **Milvus / Weaviate / pgvector** — backups/snapshots are full, no vector-native COW branch.

Comparable *data-versioning* prior art (none vector-index-native): **lakeFS**, **DVC**,
**git-LFS** (object/data versioning); **Delta Lake / Apache Iceberg** time-travel (table
snapshots). RVF's contribution would be bringing cheap COW branching **down to the
vector-index file** — which is novel. The proven 162 B / 0.5 ms base-independent branch
*creation* is exactly the primitive those systems lack for vector indexes.

### What actually works today vs. not

**Works today (real, differentiating):**
- Per-experiment **snapshot pointers** / **agent memory checkpoints**: each branch is a 162 B
  + own-edits delta; creating thousands of branches off a 496 MB base costs ~0.8 ms and ~KB
  each instead of 65 ms and 496 MB per copy.
- A/B index *states* where each branch accumulates and is queried for **its own** vectors;
  the parent is queried separately (re-open by path). Provenance/lineage is cryptographically
  tracked (parent hash + witness chain).

**Does not work today (the "git-like" reading):**
- Querying a branch as **base + edits union** — parent vectors are invisible to the child.
- The "1M vectors, 100 edits = 2.5 MB branch" mental model of a fat overlay over inherited
  clusters — the shipped branch is a thin delta of only the new vectors.

---

## Honest answer to the brief

> *Is RVF COW branching a real, proven differentiator — and do the README perf claims hold?*

- **Branch creation primitive:** real, proven, and genuinely differentiating — cheap (162 B /
  ~0.5 ms), correct (isolation + lineage verified), and **base-size-independent** while the
  naive baseline is O(base). This is the novel capability vs faiss/hnswlib/qdrant.
- **"Git-like COW" as a *queryable* branch:** **not delivered** through the public/node API.
  The child is a lineage delta, not a parent∪child overlay; the real cluster-COW engine is
  unexposed and not wired to queries.
- **Perf claims:** "2.5 MB/100-edit branch" not reproduced (real: 51 KB, different mechanism);
  "125 ms boot" holds only to ~hundreds-of-K vectors (1M: 242.6 ms); "12 µs query" is not an
  end-to-end figure (real node k=10 p50: 174–316 µs). Plus a real **1M HNSW build cliff**
  (>14 min first query).

**Net:** RVF COW is a *promising and partially-real* differentiator. The hard part — cheap,
correct, sublinear branch creation — is done and is SOTA-novel for vector indexes. The
remaining gap to the headline claim is wiring the existing `CowEngine` read-through into the
store query path and exposing `branch()` (not just `derive()`) in the bindings. Until then,
market it as **vector-index snapshot/lineage checkpointing**, not **queryable git-like COW**.

---

## Reproduce

```bash
cd /home/ruvultra/projects/ruvector
# full table (10k + 100k; 1M optional, slow):
SIZES=10000,100000 node rvf-cow-bench.js
# instrumented 1M (build/open/derive/copy; warm query blocked by HNSW build):
node rvf-1m-probe.js
```

Correctness probes used: query the child for a known *base* vector (expect: not found → only
edits visible); inspect `child.segments()` (expect: manifest + own VEC only, no COW_MAP);
reopen child standalone and check `status().totalVectors` (expect: edit count only).
