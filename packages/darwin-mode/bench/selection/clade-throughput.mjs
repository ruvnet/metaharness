#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Throughput micro-benchmark for cladeThompsonSelect() (ADR-094). Deterministic
// (seeded PRNG, no wall-clock in the numbers that get committed) — builds a
// synthetic archive of a given shape and size, then measures how long a single
// selection pass takes as the archive grows. Two shapes on purpose: 'chain' is
// the worst case for a naive per-node subtree walk (each node's subtree walk
// almost fully overlaps its parent's), 'branching' is closer to a real
// evolutionary run (each parent has a handful of children per generation).
//
// Usage: node bench/selection/clade-throughput.mjs [--out results/clade-throughput.json]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Archive } from '../../dist/archive.js';
import { cladeThompsonSelect } from '../../dist/clade.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function variant(id, parentId) {
  return { id, parentId, generation: 0, dir: `/tmp/${id}`, mutationSurface: 'planner', mutationSummary: id, createdAt: '2026-06-17T00:00:00.000Z' };
}
function score(id, promoted) {
  return {
    variantId: id, taskSuccess: 1, testPassRate: 1, traceQuality: 0.9,
    costEfficiency: 1, latencyEfficiency: 1, safetyScore: 1,
    secretExposure: 0, destructiveAction: 0, hallucinatedFile: 0, toolLoop: 0, costOverrun: 0,
    baseScore: 0.985, finalScore: 0.985, promoted, reason: 'bench',
  };
}

function buildChainArchive(rng, n) {
  const a = new Archive('/unused-bench.json');
  a.addVariant(variant('root', null));
  a.setScore('root', score('root', rng() > 0.5));
  let prev = 'root';
  for (let i = 0; i < n; i++) {
    const id = `n${i}`;
    a.addVariant(variant(id, prev));
    a.setScore(id, score(id, rng() > 0.4));
    prev = id;
  }
  return a;
}

function buildBranchingArchive(rng, n, branchFactor) {
  const a = new Archive('/unused-bench.json');
  a.addVariant(variant('root', null));
  a.setScore('root', score('root', rng() > 0.5));
  let frontier = ['root'];
  let created = 0;
  while (created < n) {
    const next = [];
    for (const parent of frontier) {
      for (let b = 0; b < branchFactor && created < n; b++) {
        const id = `n${created}`;
        a.addVariant(variant(id, parent));
        a.setScore(id, score(id, rng() > 0.4));
        next.push(id);
        created++;
      }
    }
    frontier = next.length > 0 ? next : frontier;
  }
  return a;
}

function benchOne(label, archive, calls) {
  const start = process.hrtime.bigint();
  let sink = 0;
  for (let s = 0; s < calls; s++) {
    const picked = cladeThompsonSelect(archive, 5, 3, s);
    sink += picked.length;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    label,
    archiveSize: archive.all().length,
    calls,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    callsPerSec: Math.round((calls / elapsedMs) * 1000),
    sinkCheck: sink > 0,
  };
}

const rng = mulberry32(7);
const scenarios = [
  { label: 'chain n=200', archive: buildChainArchive(rng, 200), calls: 50 },
  { label: 'chain n=800', archive: buildChainArchive(rng, 800), calls: 20 },
  { label: 'branching n=800 bf=4', archive: buildBranchingArchive(rng, 800, 4), calls: 20 },
  { label: 'branching n=3000 bf=4', archive: buildBranchingArchive(rng, 3000, 4), calls: 10 },
];

const results = scenarios.map((s) => benchOne(s.label, s.archive, s.calls));
console.table(results);

const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? process.argv[outArg + 1] : join(__dirname, '..', 'results', 'clade-throughput.json');
writeFileSync(outPath, JSON.stringify({ generatedFrom: 'bench/selection/clade-throughput.mjs', results }, null, 2) + '\n');
console.log(`\nWrote ${outPath}`);
