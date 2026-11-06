# @metaharness/kernel 0.1.5: a working RVF memory backend

Package: `@metaharness/kernel@0.1.5` only.

In 0.1.4, `createRvfBackend()` looked for a `createIndex` export that no `@ruvector/rvf` release has ever had. So it always returned `null`, and memory never used RVF. In 0.1.5, `memory-rvf.ts` is rewritten against the real `RvfDatabase` API:

| Kernel backend | `@ruvector/rvf` |
| --- | --- |
| namespace | one `<dir>/<namespace>.rvf` file (and its `.rvf.idmap.json` id map) |
| `insert` / `insertBatch` (new) | `ingestBatch`. A re-insert replaces the vector. A rejected vector throws. |
| `search(vec, k, ns, { exact, efSearch })` | `query(vec, k, { forceExact, efSearch })`. Cosine `score = 1 - distance`, and the raw `distance` is also returned. |
| `delete(ids, ns)` (new) | `delete(ids)` |
| `size(ns?)` | `status().totalVectors` |
| `flush()` | no-op. Each write is committed when its promise resolves. |
| `close()` (new) | `close()`, which releases RVF's single-writer lock |

Behaviour changes:

- `createRvfBackend({ dimensions, metric?, dir?, m?, efConstruction? })`. `dir` is where the store persists. Without it, the backend uses a temporary directory and removes it on `close()`.
- `null` is returned only when `@ruvector/rvf` is not installed (or has no `RvfDatabase`). Every other failure throws: a missing native binding, a held lock, or a dimension mismatch.
- Namespaces are checked against `[A-Za-z0-9._-]{1,128}` and may not start with `.`, because they become file names.
- Concurrent first use of a namespace opens its file once. The handle promise is cached rather than the resolved value, which fixes the `ensure(ns)` race noted in the 2026-10-09 dream-cycle review.

Not supported, because RVF cannot do it yet: per-vector metadata (ruvector issue #704). Hits carry no `storedAt`, so `rankWithDecay` cannot reorder RVF hits by age. `{ exact: true }` is passed through only by `@ruvector/rvf` 0.4.6 and later (rvf-node 0.4.1). Earlier versions ignore it, and search stays on HNSW.

Peer range narrowed from `^0.2.0 || ^0.3.0 || ^0.4.0` to `^0.3.0 || ^0.4.0`. This is deliberate, one release after 0.1.4 widened it. The backend was probed against 0.2.3: deleting 1 of 200 vectors and reopening the file still reported 200, and per-vector metadata was accepted and silently dropped. 0.3.4 and 0.4.6 both keep the delete across a reopen and reject metadata explicitly.

`@ruvector/rvf@^0.4.6` is now a devDependency of `packages/kernel-js`, so CI runs the real-import tests. Those tests store 600 vectors, reopen the store from disk, and check exact top-10 against brute force, HNSW recall, delete and upsert persistence, namespace isolation, input validation, the lock, and the fallback when rvf is absent.

## Measured

Run with `node packages/kernel-js/bench/memory-rvf-bench.mjs N DIM 200` on `@ruvector/rvf` 0.4.6 and Node 22. The data was seeded uniform random vectors with cosine distance. Queries ran at k = 10 against brute force after the store was reopened. The figures are medians of 5 runs (10k × 128) and 3 runs (1k × 128) on a shared host at load average about 32, so the latencies are noisy. Recall was identical across runs.

| Metric | 1k × 128 | 10k × 128 | 10k × 384 |
| --- | --- | --- | --- |
| recall@10, HNSW (efSearch 100) | 1.000 | 0.972 | 0.8745 |
| recall@10, `exact: true` | | 1.000 | |
| search p50 / p95 | 0.11 ms | 1.26 ms / 2.09 ms | |
| exact search p50 | | 0.74 ms | |
| `insert()` p50 / p95 (one commit each) | | 5.2 ms / 17.1 ms | |
| `insertBatch` per vector (batches of 500) | | 0.031 ms | |

The published file list matches 0.1.4 (`dist/**`, `README.md`, `LICENSE`, `package.json`). `dist/memory-rvf.*` changes content. No files are added or removed.

Reproduce: `npm ci --ignore-scripts`, `npm run build`, `npx vitest run packages/kernel-js`, `RELEASE_PACKAGES=kernel-js node scripts/dream-release.mjs pack`, `RELEASE_PACKAGES=kernel-js node scripts/dream-release.mjs smoke`.
