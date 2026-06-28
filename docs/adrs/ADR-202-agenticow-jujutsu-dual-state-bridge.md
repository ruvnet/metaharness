# ADR-202: Dual-state branching — agentic-jujutsu (code/op) ⇄ agenticow (memory)

**Status:** Accepted — bridge fully wired end-to-end: jj 0.35.0 bookmarks + agenticow COW + native ANN-across-branch now SHIPPED (agenticow@0.2.0 + @ruvector/rvf-node@0.2.0, rvf-runtime PRs #617+#618). recall@10 = 1.0000 verified. @metaharness/jujutsu@0.2.0 published.
**Date:** 2026-06-28
**Related:** ADR-006 (memory & learning integration), ADR-022 (MCP primitive), ADR-074 (darwin ruvector memory fabric), ADR-161 (ruvector memory tiers), ADR-201 (vector-memory lift). Architectural constraint: **ADR-150 principle** (removable augmentation, never a required runtime dep — see "On ADR-150" below).

## Context

A coding agent that explores must branch and roll back **two** state planes:

1. **The code/op plane** — what the agent *did*: edits, commits, rebases. We
   adopt [`agentic-jujutsu`](https://www.npmjs.com/package/agentic-jujutsu)
   (npm v2.3.6), a Rust+NAPI wrapper over the Jujutsu (`jj`) VCS. It exposes a
   lock-free **operation log**, **QuantumDAG** agent coordination (conflict
   detection across concurrent agents), a **ReasoningBank** trajectory learner,
   and **ML-DSA-65** quantum-resistant operation signing.
2. **The memory plane** — what the agent *learned*: the vectors in its
   ReasoningBank/RAG store. We adopt
   [`agenticow`](https://www.npmjs.com/package/agenticow) (npm v0.1.0), a
   copy-on-write vector-branching layer over ruvector's RVF format. It derives a
   branch off any base in **~0.5 ms / 162 bytes regardless of base size**
   (83× faster, ~3000× smaller than full-copy snapshots at 1M vectors).

Used independently the planes **drift**: an agent can revert its code while
keeping memory poisoned by the abandoned trajectory, or promote a memory delta
whose ops it never merged. The fix is a **1:1 dual-state branch**: one agent ⇒
one op branch + one memory branch, created/learned/reverted/merged as a unit.

This ADR records the bridge design, what is wired vs stubbed, and a real
upstream bug found + worked around during integration.

## Decision

Ship `@metaharness/jujutsu` (`packages/jujutsu`) exposing:

- **A capability facade** (`JujutsuCapability`) over agentic-jujutsu's op-log /
  coordination / trajectory / signing primitives, with honest capability
  reporting via `probe()`.
- **A dual-state bridge** (`DualStateBridge`) implementing the four lifecycle
  verbs over a ports-and-adapters seam.

### The 1:1 lifecycle mapping

| Verb | Code/op branch (agentic-jujutsu) | Memory branch (agenticow) | Status |
|---|---|---|---|
| **spawn** | `registerAgent` (QuantumDAG) + `jj bookmark create` + `startTrajectory` | `fork()` off the read-only base + `checkpoint('spawn')` | **wired** |
| **learn** | `finalizeTrajectory(score, critique)` + read op-sequence (`getUserOperations`) | embed op-sequence → `ingest()` into the branch (ReasoningBank-as-agenticow) | **wired** |
| **revert** | `jj undo` (op-log rollback) | `rollback()` to the spawn checkpoint (drops the delta) | **wired** |
| **merge/promote** | `jj squash` ops into base + drop bookmark | `promote()` winning delta into the base memory | **wired** |
| **query** | — | cross-branch k-NN | **WIRED** (native ANN, recall@10=1.0) |

### Ports & adapters (hexagonal)

The bridge depends only on three interfaces so it is testable offline and
degrades when a plane is absent:

- `OpBranchProvider` — code/op plane. Real: `AgenticJujutsuOpProvider`. Mock:
  `MockOpProvider`.
- `MemoryBranchProvider` — memory plane. Real: `AgenticowMemoryProvider`. Mock:
  `MockMemoryProvider`.
- `MemoryQueryProvider` — the cross-branch query plane. Real (native ANN):
  `AgenticowQueryProvider` (`nativeAnn=true`). Mock: `MockQueryProvider`
  (honest brute-force cosine).

### What is wired (all planes)

- **Wired & verified end-to-end:** spawn/learn/revert/merge with *both* real
  native planes — jj 0.35.0 bookmark branch + agenticow COW branch + trajectory
  finalize + op-sequence embedding + COW ingest/rollback/promote. 15/15 unit
  tests + an offline smoke test + a real-peer integration check all green.
- **WIRED — cross-branch ANN query (agenticow@0.2.0 + rvf-node@0.2.0):**
  `branch()` now calls `base.fork(label, undefined, { nativeAnn: true })` which
  uses `RvfDatabase.branch()` (a real COW child with the Rust dual-graph HNSW
  engine, rvf-runtime PRs #617+#618). `AgenticowQueryProvider.nativeAnn = true`.
  A single `db.query()` call on the COW child queries both its own HNSW and the
  parent's HNSW, merges candidates with child-wins semantics, and excludes
  tombstoned IDs entirely in Rust. **recall@10 = 1.0000** verified with 1200-
  vector L2 corpus, 60 new + 20 overrides + 10 tombstones, efSearch=300.
  Exact read-through remains the correctness fallback when the COW engine is
  inactive (`opts.forceExact = true` or pre-0.2.0 agenticow).

## On ADR-150 (removable augmentation)

The task brief cites "ADR-150 (removable augmentation, never a required runtime
dep)". Note a **numbering nuance**: in *this* repo `docs/adrs/ADR-150` is
"Tailscale-served local frontier model". The *principle* invoked — MetaHarness
augmentations must be optional and removable — is the one the ruflo-metaharness
plugin enforces as its "ADR-150 constraint". We honor the **principle** here:
`agentic-jujutsu` and `agenticow` are **optional peer dependencies**
(`peerDependenciesMeta.optional`). The package imports and type-checks with
neither installed; `probe()` reports what is live; the bridge runs degraded (or
fully mock-backed) when a plane is missing. Nothing in MetaHarness's required
runtime path depends on either native peer.

## Upstream bug found (agentic-jujutsu ≤ 2.3.6)

`JjWrapper.branchCreate()` shells out to the **removed** `jj branch create`
subcommand. Jujutsu **≥ 0.21** renamed `jj branch` → `jj bookmark`, and the
addon **bundles jj 0.35.0**, so the call fails at runtime:

```
jj command failed: error: unrecognized subcommand 'branch'
```

This breaks the core branch primitive (and, by the same token, `branchDelete`
→ `jj branch delete`, `branchList` → `jj branch list`). The Rust
`OperationType` enum already carries both `Branch` and `Bookmark` variants, so
the model knows about bookmarks — only the CLI invocation was never migrated.

**Workaround (this package):** `AgenticJujutsuOpProvider` drives branching via
`execute(['bookmark', 'create', '-r', rev, name])` and only falls back to
`branchCreate()` for old jj. **Upstream fix (to be PR'd to
`ruvnet/agentic-flow`, `packages/agentic-jujutsu`):** version-detect `jj`
(`jj --version`) and select `branch` vs `bookmark`, or migrate to `bookmark`
and document a minimum jj version. Warrants a patch release (e.g. 2.3.7).

## Consequences

- **Positive:** agents get atomic dual-state checkpoints; abandoned trajectories
  cannot leave poisoned memory; winning deltas promote with their ops. Cross-
  branch ANN query now routes through the native Rust COW dual-graph merge
  (recall@10 = 1.0, O(log n) in parent size) — no longer O(n) read-through.
- **Negative / deferred:** the default `HashEmbedder` is a placeholder (inject
  a real ONNX model for production recall); the op plane requires the `jj` CLI
  at runtime (the addon bundles it); the upstream `jj branch` bug must be fixed
  in agentic-jujutsu for the native `branchCreate`/`branchList`/`branchDelete`
  surface to work on modern jj. Darwin/win32/arm64 platform packages for
  @ruvector/rvf-node@0.2.0 require CI cross-compilation (linux-x64-gnu ships;
  other platforms still at 0.1.7 until a CI release cycle).

## Verification

- `npm run -w @metaharness/jujutsu build` — clean (tsc, no native dep needed).
- `npm run -w @metaharness/jujutsu test` — 15/15 (offline, mock-backed).
- `npm run -w @metaharness/jujutsu smoke` — offline lifecycle + capability probe.
- Real-peer check (with `agentic-jujutsu` + `agenticow@0.2.0` installed + bundled jj
  0.35.0): full spawn→learn→query→revert→merge cycle green with native ANN.
- Rust integration test `cow_ann_recall_vs_exact`: recall@10 = 1.0000 (rvf-runtime PR #618).
- agenticow JS acceptance: `fork({nativeAnn:true}).query()` recall@10 = 1.0000 vs exact brute-force.
- npm smoke install: `@ruvector/rvf-node@0.2.0` + `agenticow@0.2.0` verified from registry.
