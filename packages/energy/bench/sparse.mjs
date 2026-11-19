// SPDX-License-Identifier: MIT
import { solve, random, evaluate } from '../dist/index.js';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
const rng = random(18374);
const models = Array.from({ length: 100 }, () => {
  const n = 100;
  return {
    unary: Array.from({ length: n }, () => Array.from({ length: 4 }, () => Math.floor(rng() * 20))),
    pairs: Array.from({ length: n - 1 }, (_, i) => ({ i, j: i + 1,
      costs: Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => Math.floor(rng() * 20))) })),
  };
});
const opts = { maxMoves: 4000, restarts: 8, seed: 42 };
for (let i = 0; i < 20; i++) for (const incremental of [true, false]) solve(models[i], { ...opts, incremental });
const times = { sparse: [], full: [] }; let mismatches = 0, invalid = 0;
for (let i = 0; i < models.length; i++) {
  const results = [];
  for (const incremental of i % 2 ? [true, false] : [false, true]) {
    const start = performance.now(), r = solve(models[i], { ...opts, incremental });
    times[incremental ? 'sparse' : 'full'].push(performance.now() - start);
    results.push(r);
    if (r.state && evaluate(models[i], r.state).violations) invalid++;
  }
  if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) mismatches++;
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const report = { workload: '100 synthetic chain graphs; 100 variables, 4 values, 99 edges',
  seed: 18374, options: opts, node: process.version,
  sparseMeanMs: mean(times.sparse), fullMeanMs: mean(times.full),
  speedup: mean(times.full) / mean(times.sparse), mismatches, invalid,
  limitations: ['Arithmetic equivalence and latency benchmark; no optimality or production claim'] };
console.log(JSON.stringify(report, null, 2));
if (process.env.ENERGY_REPORT) writeFileSync(process.env.ENERGY_REPORT, JSON.stringify(report, null, 2) + '\n');
if (mismatches || invalid) process.exitCode = 1;
