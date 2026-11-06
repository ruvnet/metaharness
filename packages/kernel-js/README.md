# @metaharness/kernel

Cross-platform kernel for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

## What it is

A Rust kernel compiled to two npm-shippable targets:

- **WebAssembly** (primary distribution — runs on Node, browser, Cloudflare Workers, Deno, Bun, edge)
- **NAPI-RS native** (per-platform `.node` binaries — escape hatch for Node hot paths)

At load time, `loadKernel()` prefers an installed per-platform native package, then wasm, then the dependency-free JavaScript backend.

## Install

```bash
npm install @metaharness/kernel
```

The native packages (`@metaharness/kernel-darwin-arm64`, `-linux-x64-gnu`, etc.) are optional peers. They are not yet available from the public npm registry (checked 2026-10-27), so they are not installed automatically. The native loader still discovers a compatible package when explicitly installed; otherwise wasm or JavaScript is used. Restore automatic native installation only after the platform packages are published and clean npm 10/11 installs are verified. This source change does not alter already-published kernel versions.

## Usage

```js
import { loadKernel } from '@metaharness/kernel';

const kernel = await loadKernel();
const info = kernel.kernelInfo();
console.log(`kernel ${info.version} (${kernel.backend})`);

// Validate an MCP server spec.
const err = kernel.mcpValidate(JSON.stringify({
  name: 'demo',
  command: ['npx', '-y', 'demo'],
}));
if (err) throw new Error(err);
```

### Memory subsystem (subpath export)

```js
import { rankWithDecay } from '@metaharness/kernel/memory';

const ranked = await rankWithDecay(hits, {
  useDecay: true,
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,  // 7-day half-life
});
```

Wraps `@ruvector/emergent-time` for HNSW decay scoring.

### RVF memory backend (optional, persistent)

`@metaharness/kernel/memory-rvf` stores memory vectors on disk in
[`@ruvector/rvf`](https://www.npmjs.com/package/@ruvector/rvf) files and searches
them with RVF's HNSW index. RVF is an optional peer dependency. Install it to
enable the backend:

```sh
npm install @metaharness/kernel @ruvector/rvf
```

```js
import { createRvfBackend } from '@metaharness/kernel/memory-rvf';

const mem = await createRvfBackend({ dimensions: 384, dir: './.harness/memory' });
if (!mem) {
  // @ruvector/rvf is not installed: keep using the default in-process memory.
} else {
  await mem.insertBatch([{ id: 'note-1', embedding }], 'notes'); // re-insert = replace
  const hits = await mem.search(query, 10, 'notes');         // [{ id, score, distance, namespace }]
  const exact = await mem.search(query, 10, 'notes', { exact: true }); // brute force
  await mem.delete(['note-1'], 'notes');
  await mem.close(); // releases the file lock; reopen the same dir later to continue
}
```

- Each namespace is one file, `<dir>/<namespace>.rvf`, plus its `.rvf.idmap.json`
  id map. Keep the two together. Writes are committed when their promise
  resolves. `flush()` is a no-op.
- `createRvfBackend()` returns `null` only when `@ruvector/rvf` is not installed.
  Errors after that are thrown, not swallowed: a missing native binding, a
  dimension mismatch, or a second writer on the same file (RVF holds a
  single-writer lock until `close()`).
- With the default `cosine` metric, `score` is cosine similarity
  (`1 - distance`). With `l2` it is `1 / (1 + distance)`, which ranks the same
  way but is not a cosine similarity.
- Not supported: RVF has no per-vector metadata yet (ruvector issue #704), so
  hits carry no `storedAt`, and `rankWithDecay` treats them all as age 0.
  `{ exact: true }` needs `@ruvector/rvf` 0.4.6 or later. Earlier versions ignore it.
- Supported range: `@ruvector/rvf` `^0.3.0 || ^0.4.0`. On 0.2.3, deletes did not
  survive a reopen.

Measured with `bench/memory-rvf-bench.mjs` on `@ruvector/rvf` 0.4.6 and Node 22.
The data was seeded uniform random vectors with cosine distance. Each run used
200 queries at k = 10, scored against brute force after closing and reopening the
store. The figures are medians of 5 runs (10k) and 3 runs (1k) on a shared,
heavily loaded host, so the latencies are indicative only.

| Set | recall@10 (HNSW) | recall p50 / p95 | exact scan p50 | `insert()` p50 / p95 | `insertBatch` per vector |
|---|---|---|---|---|---|
| 1k × 128 | 1.000 | 0.11 ms / – | – | – | – |
| 10k × 128 | 0.972 | 1.26 ms / 2.09 ms | 0.74 ms (recall 1.0) | 5.2 ms / 17.1 ms | 0.031 ms |
| 10k × 384 | 0.8745 | – | – | – | – |

At this scale the exact scan was as fast as HNSW or faster. Each `insert()` is
its own durable commit, so batch your writes.

## Subsystems

| Subsystem | What it does |
|---|---|
| `mcp` | MCP server spec + tool registry |
| `hooks` | Lifecycle hook dispatch with permission-decision merge |
| `memory` | AgentDB bridge + emergent-time decay weighting |
| `routing` | 3-tier routing (codemod / Haiku / Sonnet-Opus) |
| `intel` | Intelligence pipeline phases |
| `claims` | Claims-based authorization |
| `witness` | Ed25519-signed provenance manifests |

## License

MIT
