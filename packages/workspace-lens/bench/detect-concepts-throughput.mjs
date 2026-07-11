#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Throughput micro-benchmark for detectConcepts() (packages/workspace-lens/src/safety.ts).
// Deterministic (seeded PRNG, no wall-clock in the numbers that get committed) —
// builds a synthetic lens + concept library shaped like real usage: a handful
// of layers x positions per trace (states), a fixed concept library scanned
// repeatedly across many detectConcepts() calls (one per governed decision/
// trace, per the module's own doc comment).
//
// Usage: node bench/detect-concepts-throughput.mjs [--out results/detect-concepts-throughput.json]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WorkspaceLens } from '../dist/lens.js';
import { detectConcepts } from '../dist/safety.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function buildLens(rng, { dModel, layers }) {
  const artifact = {
    lensId: 'jlens-bench-v1',
    modelId: 'bench-model',
    dModel,
    vocab: ['a', 'b', 'c'],
    unembed: [randVec(rng, dModel), randVec(rng, dModel), randVec(rng, dModel)],
    layers: Array.from({ length: layers }, (_, l) => ({
      layer: l,
      // identity Jacobian so project(h) = h, keeps the bench focused on detectConcepts, not matVec
      jacobian: Array.from({ length: dModel }, (_, i) => Array.from({ length: dModel }, (_, j) => (i === j ? 1 : 0))),
    })),
  };
  return WorkspaceLens.fromArtifact(artifact);
}

function buildConcepts(rng, { count, dModel }) {
  return Array.from({ length: count }, (_, i) => ({
    concept: `concept-${i}`,
    modelId: 'bench-model',
    vector: randVec(rng, dModel),
  }));
}

function buildStates(rng, { count, layers, dModel }) {
  return Array.from({ length: count }, (_, i) => ({
    layer: i % layers,
    position: i,
    h: randVec(rng, dModel),
  }));
}

function benchOne({ dModel, layers, numConcepts, numStates, calls }) {
  const rng = mulberry32(42);
  const lens = buildLens(rng, { dModel, layers });
  const concepts = buildConcepts(rng, { count: numConcepts, dModel });
  const states = buildStates(rng, { count: numStates, layers, dModel });

  const start = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < calls; i++) {
    const triggers = detectConcepts(lens, states, concepts, { threshold: 2 }); // unreachable threshold — count all, cheap
    sink += triggers.length;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  return {
    dModel, layers, numConcepts, numStates, calls,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    callsPerSec: Math.round((calls / elapsedMs) * 1000),
    sinkCheck: sink >= 0,
  };
}

// NOTE: lens.project() is an O(dModel^2) dense matVec per state, called once
// per state regardless of this optimization, and unrelated to it — for the
// benchmark to actually measure detectConcepts' O(numStates x numConcepts)
// concept loop (what we optimized) instead of being swamped by project()'s
// per-state matrix multiply, dModel needs to be small relative to
// numConcepts (project cost ~ numStates*dModel^2 must stay well under the
// concept loop's numStates*numConcepts*dModel).
const scenarios = [
  { dModel: 128, layers: 4, numConcepts: 200, numStates: 20, calls: 300 },
  { dModel: 128, layers: 4, numConcepts: 1000, numStates: 20, calls: 100 },
  { dModel: 256, layers: 4, numConcepts: 1000, numStates: 40, calls: 40 },
  { dModel: 256, layers: 4, numConcepts: 3000, numStates: 40, calls: 15 },
];

const results = scenarios.map(benchOne);
console.table(results);

const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? process.argv[outArg + 1] : join(__dirname, 'results', 'detect-concepts-throughput.json');
writeFileSync(outPath, JSON.stringify({ generatedFrom: 'bench/detect-concepts-throughput.mjs', results }, null, 2) + '\n');
console.log(`\nWrote ${outPath}`);
