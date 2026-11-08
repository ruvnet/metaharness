# @metaharness/kernel 0.1.6: per-vector metadata on the RVF backend

Package: `@metaharness/kernel@0.1.6` only.

`@ruvector/rvf` 0.4.7 (rvf-node 0.4.2) adds durable per-vector metadata (ruvector #704). That was the blocker recorded for 0.1.5. `memory-rvf` now uses it:

- `insert(id, vec, ns, { storedAt?, metadata? })` and `insertBatch([{ id, embedding, storedAt?, metadata? }])` store `storedAt` with every vector. It defaults to `Date.now()`. Any caller `metadata`, such as `{ source, tags }`, is stored too. `storedAt` is a reserved metadata key.
- Hits carry `storedAt` and `metadata`, and both survive a close and reopen.
- `search(vec, k, ns, { filter })` passes RVF filter expressions through: `{ op, field, value }` leaves combined with `and`, `or` and `not`.
- `backend.metadataSupported` reports whether writes carry metadata.

## Decay now reorders

`rankWithDecay` never reordered anything, for in-process or RVF hits. It expected `@ruvector/emergent-time`'s `AgenticClock` to have a `weight(ageMs)` method. No 0.1.x release has one: that clock measures an agent's internal time from state deltas. Its WASM is also not initialised on import in Node. So the loader returned null, and the fallback copied the raw score into `decayedScore`.

The fallback now applies the half-life weight `0.5^(age / halfLifeMs)` (`linearDecay`). `score` stays the raw similarity. Hits without `storedAt` are age 0, as before. An emergent-time clock that does expose `weight(ageMs)` is still preferred.

## Older RVF

`@ruvector/rvf` < 0.4.7, or a 0.4.7 SDK on rvf-node < 0.4.2, rejects metadata with `MetadataNotSupported` (0xff04) before it writes anything. The backend catches that once and retries the same write without metadata. It then stays in that mode, with `metadataSupported === false`, and behaves exactly as 0.1.5 did: no `storedAt` on hits and no throw. A `filter` in that mode throws instead of silently returning unfiltered hits.

Stores written by 0.1.5 on rvf 0.4.6 open unchanged under 0.4.7. Their vectors come back without `storedAt`, and new writes to the same file carry it. A committed fixture written by kernel 0.1.5 and rvf 0.4.6 tests this.

Peer range: `^0.3.0 || ^0.4.7` (was `^0.3.0 || ^0.4.6`). The import is still lazy and optional. Without rvf, `createRvfBackend()` returns `null`. The devDependency is now `^0.4.7`.

## Tests

`__tests__/memory-rvf-metadata.test.ts` runs against the installed rvf 0.4.7 and covers:

- metadata surviving a reopen;
- an older exact duplicate ranking below a newer near-duplicate under `rankWithDecay`, while raw order keeps it first;
- `eq`, `ge` and `and` filters on caller metadata and `storedAt`;
- a type conflict throwing `MetadataTypeConflict` (0xff09), plus the reserved key and a non-finite `storedAt` being rejected;
- the 0.1.5/0.4.6 fixture opening, including a deleted id staying deleted.

Two more tests mock an older rvf to cover the fallback: the 0.4.6 SDK, and the 0.4.7 SDK on an old rvf-node.

## Measured

Run with `node packages/kernel-js/bench/memory-rvf-bench.mjs 10000 DIM 200` on `@ruvector/rvf` 0.4.7, rvf-node 0.4.2 and Node 22. Every insert carries its `storedAt` metadata. The setup otherwise matches 0.1.5: seeded uniform vectors, cosine, k = 10, unfiltered HNSW at the default efSearch 100, measured after reopen.

The figures are medians of 5 sequential runs on a shared host at load average about 19. Running the 10 benches in parallel doubled search p50 to 2.2–2.7 ms, so the runs were staged. The baseline column is kernel 0.1.5 on rvf 0.4.6, which also resolves rvf-node 0.4.2, on the same host in the same session.

| Metric | 10k × 128 | baseline | 10k × 384 | baseline |
| --- | --- | --- | --- | --- |
| recall@10, HNSW | 0.972 | 0.972 | 0.8745 | 0.8745 |
| recall@10, `exact: true` | 1.000 | 1.000 | 1.000 | 1.000 |
| search p50 / p95 | 0.76 / 1.20 ms | 0.70 / 1.10 ms | 1.40 / 1.98 ms | 1.48 / 2.62 ms |
| exact search p50 | 0.58 ms | 0.55 ms | 1.63 ms | 1.62 ms |
| `insert()` p50 / p95 | 16.8 / 21.7 ms | 12.4 / 14.4 ms | | |
| `insertBatch` per vector | 0.039 ms | 0.029 ms | 0.044 ms | 0.035 ms |

Recall did not change. In particular, 10k × 384 is still 0.8745, so rvf 0.4.7 does not include a dimension-aware ef floor. Storing metadata costs about a third more per write. Search latency is within noise.

Reproduce: `npm ci --ignore-scripts`, `npm run build`, `npx vitest run packages/kernel-js`, `RELEASE_PACKAGES=kernel-js node scripts/dream-release.mjs pack`, `RELEASE_PACKAGES=kernel-js node scripts/dream-release.mjs smoke`.
