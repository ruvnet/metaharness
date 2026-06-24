# ADR-190 — AST-Fused Dynamic Mincut for Structural Pre-Seeding (localization)

**Status:** Proposed (M-effort build, deferred until ADR-189 settles)
**Date:** 2026-06-24
**Related:** ADR-185 (SOTA-breaking levers, **Lever #1 — function-level localization**), ADR-189 (Chebyshev temperature), `crates/poker-darwin` / `ruvector` (PR #49)

---

## Context

ADR-185's deep-research pass found the cheap-tier ~34% resolve floor is **not primarily a cognitive boundary — it is a localization bottleneck**: BM25 (and flat Top-K cosine) retrieves *no* oracle file in ~50% of instances at a 27K-token limit. Every point of localization recall is ≈ a point of resolve for cheap models ("the model never saw the right file").

Flat embedding retrieval treats code as a bag of vectors. A report saying "database connection failure" scores `query_builder.py` highly but misses the structural root cause in `connection_pool.py` because the lexical/semantic overlap is weak — yet the call graph connects them directly. The fix is to move from **semantic search → graph partitioning**, reusing the dynamic min-cut machinery validated in the `ruvector` poker arc.

Critically, our solver is an **interactive ReAct agent**, not a retrieve-then-generate pipeline — it localizes via its own `grep`/`read`. So a partition cannot blindly replace `grep`; it must be injected as a **pre-seeded structural hint at step 1**, biasing the cheap model toward the right topological neighborhood before it burns trajectory steps wandering.

---

## Decision

Build an **AST-fused dynamic mincut** (via `ruvector`) that partitions the repo into a "bug neighborhood" and injects that subgraph as a step-1 context hint.

### Graph formulation

- **Nodes:** functions/files in the target repo.
- **Source:** the embedded issue/bug-report text.
- **Sinks:** stdlib dirs, test suites, vendored deps.
- **Edge weight (the load-bearing choice — AST-fused, NOT pure cosine):**

```
w(A,B) = α · ast_adjacency(A,B)            // import + call-graph edges (tree-sitter)
       + (1−α) · cosine(emb_A, emb_B)      // semantic glue for non-structural hops
```

Start **α ≈ 0.6** (structure-dominant). Pure cosine (α=0) is rejected: it reproduces the exact BM25 blindness we are trying to kill (it would sever `connection_pool.py`). The structural signal *is* the point; cosine only glues the issue text to entry-point functions.

### Operational flow

1. **Parse:** rapid `tree-sitter` pass → AST import/call adjacency list.
2. **Partition:** build the fused graph, set issue text as source, run dynamic mincut to sever the relevant subset.
3. **Inject:** format the partitioned subgraph as a hierarchical file-tree hint into the step-1 context: *"Structural + semantic analysis suggests the issue lives in these interconnected files: …"* — a hint, not a constraint (the agent may still explore beyond it).

---

## Execution menu

| Phase | Task | Effort | Metrics | Status |
|---|---|---|---|---|
| 1 | `tree-sitter` AST parse + edge-weight fusion | M | extraction time, build overhead | Queued |
| 2 | `ruvector` dynamic mincut integration | S | partition density, **oracle recall** | Queued |
| 3 | Step-1 context injection + n=25 A/B | M | Δresolve, empty-patch rate | **Blocked on ADR-189** |

The **oracle-recall** metric (does the mincut subgraph contain the gold-patched file?) is measurable offline against the gold patch *without* feeding it to the solver — a conformant way to validate localization before any resolve run.

---

## Consequences

- **Attacks the 50% miss directly:** handing the agent a structurally intact dependency neighborhood should sharply raise oracle-file recall → lift the cheap floor (ADR-185 projects ds-v4 34% → 40%+ purely from better localization).
- **Compounds with FUGU economics:** better base localization → fewer empty/0% patches → fewer escalations through the empty-patch gate → lower blended unit cost (less $0.50 Opus tax). This is the lever most likely to push the FUGU tier past 60% **without** raising the escalation rate.
- **Heavier lift (M):** needs stable `tree-sitter` extraction + graph build, ideally cached per repo. Deferred until ADR-189's isolated temperature A/B reports, to keep one clean lever in flight at a time.
- Conformance preserved: the hint is derived from repo structure + issue text only — **never** from gold tests.
