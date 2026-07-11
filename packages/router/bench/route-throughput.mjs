#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Throughput micro-benchmark for Router.route(). Deterministic (seeded PRNG,
// no network, no wall-clock in the numbers that get committed) — measures
// route() calls/sec against a synthetic dataset shaped like real usage: a
// handful of candidates, growing per-candidate example counts (DRACO's
// "more examples → closer to oracle" trajectory), and embedding dims that
// span the common range (128 local, 1536 OpenAI-style).
//
// Usage: node bench/route-throughput.mjs [--out results/route-throughput.json]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Router } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deterministic PRNG (mulberry32) — no Math.random(), so runs are reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randVec(rng, dim) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rng() * 2 - 1;
  return v;
}

function buildCandidates(rng, { numCandidates, examplesPerCandidate, dim }) {
  const candidates = [];
  for (let c = 0; c < numCandidates; c++) {
    const examples = [];
    for (let e = 0; e < examplesPerCandidate; e++) {
      examples.push({ embedding: randVec(rng, dim), quality: rng() });
    }
    candidates.push({ id: `model-${c}`, costPerMTok: 1 + c * 5, examples });
  }
  return candidates;
}

function benchOne({ numCandidates, examplesPerCandidate, dim, calls }) {
  const rng = mulberry32(42);
  const candidates = buildCandidates(rng, { numCandidates, examplesPerCandidate, dim });
  const router = new Router({ candidates, qualityBar: 0.7, k: 5 });
  const queries = Array.from({ length: calls }, () => randVec(rng, dim));

  const start = process.hrtime.bigint();
  let sink = 0; // prevent dead-code elimination
  for (const q of queries) {
    const r = router.route(q);
    sink += r.predictedQuality;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  return {
    numCandidates,
    examplesPerCandidate,
    dim,
    calls,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    callsPerSec: Math.round((calls / elapsedMs) * 1000),
    sinkCheck: sink > 0,
  };
}

const scenarios = [
  { numCandidates: 6, examplesPerCandidate: 20, dim: 128, calls: 2000 },   // DRACO-scale (current n≈20)
  { numCandidates: 6, examplesPerCandidate: 200, dim: 128, calls: 2000 },  // "more examples" growth path
  { numCandidates: 6, examplesPerCandidate: 20, dim: 1536, calls: 2000 },  // OpenAI-scale embeddings
  { numCandidates: 6, examplesPerCandidate: 200, dim: 1536, calls: 500 },  // both axes stressed
];

const results = scenarios.map(benchOne);
console.table(results);

const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? process.argv[outArg + 1] : join(__dirname, 'results', 'route-throughput.json');
writeFileSync(outPath, JSON.stringify({ generatedFrom: 'bench/route-throughput.mjs', results }, null, 2) + '\n');
console.log(`\nWrote ${outPath}`);
