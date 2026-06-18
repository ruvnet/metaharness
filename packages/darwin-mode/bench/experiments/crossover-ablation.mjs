// SPDX-License-Identifier: MIT
//
// ADR-115: pin down ADR-114's claim that CROSSOVER (not the selection strategy)
// is the load-bearing mechanism for crossing a two-surface epistatic deception.
// Ablation on the agent substrate (real surface code, zero LLM): {score,
// behavioral-diversity} × {crossover on, off}. Prediction: crossover-OFF crosses
// 0 (a single-surface mutation can never combine the two required surfaces),
// crossover-ON crosses regardless of selection strategy. If so, crossover is
// necessary and the selection strategy is secondary here.
//
// Run: node --experimental-strip-types --no-warnings bench/experiments/crossover-ablation.mjs

import { evolve } from '../../dist/index.js';
import { extractSurfaceParams } from '../../dist/mock-sandbox.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function distract(n) { return Array.from({ length: n }, (_, i) => `src/f_${i}.ts`); }
const DECEPTIVE = [
  { id: 'easy-1', prompt: 'fix a', files: ['src/a.ts'], buggyFile: 'src/a.ts', classification: 'transient', failAttempts: 0, backoffMs: 10, difficulty: 1 },
  { id: 'easy-2', prompt: 'fix b', files: ['src/b.ts'], buggyFile: 'src/b.ts', classification: 'transient', failAttempts: 1, backoffMs: 10, difficulty: 1 },
  { id: 'treasure', prompt: 'fix treasure', files: [...distract(38), 'src/treasure.ts'], buggyFile: 'src/treasure.ts', classification: 'transient', failAttempts: 3, backoffMs: 20, difficulty: 5 },
];
function repo() {
  const r = mkdtempSync(join(tmpdir(), 'cab-'));
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'package.json'), '{"name":"x","version":"1.0.0","private":true,"scripts":{"test":"true"}}');
  writeFileSync(join(r, 'src', 'i.js'), 'export const x=1;\n'); writeFileSync(join(r, 'README.md'), '#\n');
  return r;
}
async function crosses(selection, crossover, seed) {
  const wr = mkdtempSync(join(tmpdir(), 'cab-wr-'));
  const res = await evolve({
    repoRoot: repo(), workRoot: wr, generations: 8, childrenPerGeneration: 6, concurrency: 6, seed,
    promotionDelta: 0.001, tasks: ['t'], sandboxMode: 'agent', agentTasks: DECEPTIVE,
    selection, crossover, epistasis: crossover,
  });
  for (const r of res.records) {
    const p = await extractSurfaceParams(r.variant.dir);
    if (p.contextWindow > 38 && p.maxAttempts > 3) return true;
  }
  return false;
}
const SEEDS = [7, 11];
const out = {};
for (const crossover of [true, false]) {
  for (const sel of ['score', 'behavioral-diversity']) {
    let c = 0; for (const s of SEEDS) if (await crosses(sel, crossover, s)) c += 1;
    out[`crossover=${crossover}, ${sel}`] = `${c}/${SEEDS.length}`;
  }
}
console.log(JSON.stringify({ hypothesis: 'crossover is necessary to cross a two-surface deception; selection strategy is secondary', seeds: SEEDS, crossedTreasure: out }, null, 2));
