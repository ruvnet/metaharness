// SPDX-License-Identifier: MIT
//
// Bench for memory-tiers.ts (ADR-161 ruVector Memory Tiers).
//
// Builds a ~60-task mixed suite and runs the real optimization: an A/B of memory OFF
// vs. memory ON on the SAME seed. Reports input tokens off vs. on, the % saved, and
// the solve counts (which must NOT drop when memory is on). Writes
// bench/results/memory-tiers.json and exits 0.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defaultDepthPolicy, simulateRun } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 1234;
const N = 60;

// Synthesize a deterministic mixed suite across the four task classes.
const classes = ['repo-bound', 'greenfield', 'security', 'refactor'];
const tasks = [];
for (let i = 0; i < N; i += 1) {
  const taskClass = classes[i % classes.length];
  tasks.push({
    id: `task-${i}`,
    taskClass,
    baseTokens: 4000 + (i % 7) * 1500, // 4000..13000
    solvableWithMemory: i % 3 !== 0, // ~2/3 are solvable
  });
}

const depth = defaultDepthPolicy();
const off = simulateRun(tasks, { memoryOn: false, depth, seed: SEED });
const on = simulateRun(tasks, { memoryOn: true, depth, seed: SEED });

const tokensSavedPct = +(((off.totalTokens - on.totalTokens) / off.totalTokens) * 100).toFixed(2);

console.log(`[memory-tiers] tasks=${tasks.length} seed=${SEED}`);
console.log(`[memory-tiers] tokens OFF=${off.totalTokens} ON=${on.totalTokens} saved=${tokensSavedPct}%`);
console.log(`[memory-tiers] solved OFF=${off.solved} ON=${on.solved} (memory must not lower solve rate)`);

if (on.solved < off.solved) {
  console.error('[memory-tiers] INVARIANT VIOLATED: memory lowered the solve rate');
  process.exit(1);
}

const receipt = {
  tasks: tasks.length,
  tokensSavedPct,
  solvedOff: off.solved,
  solvedOn: on.solved,
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'memory-tiers.json'), JSON.stringify(receipt, null, 2));
console.log('[memory-tiers] receipt → bench/results/memory-tiers.json');
process.exit(0);
