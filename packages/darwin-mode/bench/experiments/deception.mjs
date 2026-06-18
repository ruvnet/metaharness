// SPDX-License-Identifier: MIT
//
// Deception experiment (ADR-105): does the advanced selection cross an EPISTATIC
// plateau that greedy score-selection cannot? The landscape has many easy tasks
// (any variant solves them) plus one "treasure" that requires BOTH a high retry
// budget AND a wide context window. Single-surface mutations toward either alone
// earn NO score gain (the easy tasks are already solved), so greedy promotion
// sees a flat plateau. Only by RETAINING the complementary stepping-stones
// (a high-retry variant in one niche, a high-context variant in another) and
// RECOMBINING them via crossover can a variant reach the treasure.
//
// Hypothesis: 'score' (greedy) stays on the plateau; 'behavioral-diversity' and
// 'clade' (which keep niche-diverse parents) + crossover cross it. Deterministic.
//
// Run: node bench/experiments/deception.mjs

import { evolve } from '../../dist/index.js';
import { extractSurfaceParams } from '../../dist/mock-sandbox.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Easy rungs (every variant solves) + a treasure needing maxAttempts>3 (≥4) AND
// window>=45 — both within the explored range, so the test is purely: can
// selection+crossover COMBINE the two reachable stepping-stones across the
// neutral plateau? (Single-surface gains are neutral: the easy tasks are
// already solved, and the treasure needs both surfaces at once.)
const DECEPTIVE = [
  { id: 'easy-1', failAttempts: 0, requiredContext: 10, backoffMs: 20, difficulty: 1 },
  { id: 'easy-2', failAttempts: 1, requiredContext: 15, backoffMs: 20, difficulty: 1 },
  { id: 'easy-3', failAttempts: 1, requiredContext: 20, backoffMs: 20, difficulty: 1 },
  { id: 'treasure', failAttempts: 3, requiredContext: 45, backoffMs: 60, difficulty: 5 },
];

function repo() {
  const r = mkdtempSync(join(tmpdir(), 'decep-'));
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', private: true, scripts: { test: 'true' } }));
  writeFileSync(join(r, 'src', 'i.js'), 'export const x=1;\n');
  writeFileSync(join(r, 'README.md'), '#x\n');
  return r;
}

async function run(selection, seed) {
  const wr = mkdtempSync(join(tmpdir(), 'decep-wr-'));
  const res = await evolve({
    repoRoot: repo(), workRoot: wr,
    generations: 20, childrenPerGeneration: 8, concurrency: 8, seed,
    promotionDelta: 0.001, tasks: ['t'], sandboxMode: 'mock', mockTasks: DECEPTIVE,
    selection, crossover: true, epistasis: true,
  });
  // Did ANY variant reach the treasure (maxAttempts>3 AND window>=45)?
  let best = 0, solvedTreasure = false;
  for (const r of res.records) {
    if (!r.score) continue;
    if (r.score.finalScore > best) best = r.score.finalScore;
    const p = await extractSurfaceParams(r.variant.dir);
    if (p.maxAttempts > 3 && p.contextWindow >= 45) solvedTreasure = true;
  }
  return { bestFinalScore: +best.toFixed(4), solvedTreasure };
}

const SEEDS = [7, 11, 23, 42, 101];
const summary = {};
for (const sel of ['score', 'behavioral-diversity', 'clade']) {
  const runs = [];
  for (const s of SEEDS) runs.push(await run(sel, s));
  summary[sel] = {
    crossedTreasure: runs.filter((r) => r.solvedTreasure).length,
    ofSeeds: SEEDS.length,
    maxBestScore: Math.max(...runs.map((r) => r.bestFinalScore)),
    perSeed: runs.map((r) => (r.solvedTreasure ? 'cross' : 'stuck')),
  };
}
console.log(JSON.stringify({
  landscape: 'easy×3 + treasure requiring BOTH maxAttempts>3 AND contextWindow>=45 (epistatic plateau)',
  generations: 20, childrenPerGeneration: 8, seeds: SEEDS, crossover: true, epistasis: true,
  summary,
}, null, 2));
