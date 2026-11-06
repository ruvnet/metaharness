// SPDX-License-Identifier: MIT
//
// Recall@10 and latency of the RVF memory backend vs exact brute force.
// Needs a build (`npm run build -w packages/kernel-js`) and @ruvector/rvf installed.
//
//   node packages/kernel-js/bench/memory-rvf-bench.mjs [N] [DIM] [QUERIES]
//
// Seeded synthetic data: N uniform random vectors in [-1, 1]^DIM, cosine metric.
// Writes in batches of 500, plus 200 single-call inserts. Measures after reopening from disk.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRvfBackend } from '../dist/memory-rvf.js';

const rvfVersion = () => { const req = createRequire(import.meta.url); let d = dirname(req.resolve('@ruvector/rvf')); while (!d.endsWith('rvf')) d = dirname(d); return JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version; };

const N = Number(process.argv[2] ?? 10000);
const DIM = Number(process.argv[3] ?? 128);
const Q = Number(process.argv[4] ?? 200);
const K = 10;
const SINGLES = 200;

let s = 0x9e3779b9;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const vec = () => Float32Array.from({ length: DIM }, () => rnd() * 2 - 1);
const norm = v => { let n = 0; for (const x of v) n += x * x; return Math.sqrt(n); };
const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const r4 = x => Math.round(x * 1e4) / 1e4;

const data = Array.from({ length: N }, (_, i) => ({ id: `m${i}`, embedding: vec() }));
const norms = data.map(d => norm(d.embedding));
const queries = Array.from({ length: Q }, vec);
const brute = q => {
  const nq = norm(q);
  const sc = data.map((d, i) => { let dot = 0; const v = d.embedding; for (let j = 0; j < DIM; j++) dot += q[j] * v[j]; return [d.id, dot / (nq * norms[i])]; });
  return new Set(sc.sort((a, b) => b[1] - a[1]).slice(0, K).map(x => x[0]));
};

const dir = mkdtempSync(join(tmpdir(), 'kernel-rvf-bench-'));
try {
  const w = await createRvfBackend({ dimensions: DIM, dir });
  if (!w) throw new Error('@ruvector/rvf not installed');
  const batchMsPerVec = [];
  const bulk = data.slice(0, N - SINGLES);
  for (let i = 0; i < bulk.length; i += 500) {
    const chunk = bulk.slice(i, i + 500);
    const t = performance.now();
    await w.insertBatch(chunk);
    batchMsPerVec.push((performance.now() - t) / chunk.length);
  }
  const single = [];
  for (const d of data.slice(N - SINGLES)) {
    const t = performance.now();
    await w.insert(d.id, d.embedding);
    single.push(performance.now() - t);
  }
  await w.close();

  const t0 = performance.now();
  const r = await createRvfBackend({ dimensions: DIM, dir });
  const size = await r.size();
  const reopenMs = performance.now() - t0;

  const run = async exact => {
    const lat = []; let hit = 0;
    for (const q of queries) {
      const truth = brute(q);
      const t = performance.now();
      const hits = await r.search(q, K, 'default', { exact });
      lat.push(performance.now() - t);
      hit += hits.filter(h => truth.has(h.id)).length;
    }
    return { recall: hit / (Q * K), p50: pct(lat, 0.5), p95: pct(lat, 0.95) };
  };
  await r.search(queries[0], K); // warm-up
  const hnsw = await run(false);
  const exact = await run(true);
  await r.close();

  console.log(JSON.stringify({
    rvf: rvfVersion(),
    node: process.version, N, DIM, queries: Q, k: K, size,
    recall_at_10: r4(hnsw.recall), p50_recall_ms: r4(hnsw.p50), p95_recall_ms: r4(hnsw.p95),
    exact_recall_at_10: r4(exact.recall), exact_p50_recall_ms: r4(exact.p50),
    p50_store_ms: r4(pct(single, 0.5)), p95_store_ms: r4(pct(single, 0.95)),
    batch_store_ms_per_vector: r4(pct(batchMsPerVec, 0.5)), reopen_ms: r4(reopenMs),
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
