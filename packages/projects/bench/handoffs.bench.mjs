// SPDX-License-Identifier: MIT
//
// Bench for handoffs.ts (ADR-163 Typed Handoffs).
//
// Measures the real optimization: typed handoff contracts reject ambiguous /
// malformed handoffs AT THE SCHEMA BOUNDARY (one corrective re-emit), while
// free-form handoffs have no boundary and burn the full retry budget downstream
// rediscovering the same malformed payloads. We run ~100 tasks in each mode and
// report the retry-reduction %. Writes bench/results/handoffs.json and exits 0.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simulateRetries } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

const TASKS = 100;
const SEED = 20260620;

const typed = simulateRetries({ typed: true, tasks: TASKS, seed: SEED });
const free = simulateRetries({ typed: false, tasks: TASKS, seed: SEED });

const retryReductionPct = +(((free.retries - typed.retries) / free.retries) * 100).toFixed(2);

console.log(`[handoffs] tasks=${TASKS} seed=${SEED}`);
console.log(`[handoffs] retries (typed)     = ${typed.retries}`);
console.log(`[handoffs] retries (free-form) = ${free.retries}`);
console.log(`[handoffs] retry reduction     = ${retryReductionPct}%`);

const receipt = {
  tasks: TASKS,
  retriesTyped: typed.retries,
  retriesFree: free.retries,
  retryReductionPct,
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'handoffs.json'), JSON.stringify(receipt, null, 2));
console.log('[handoffs] receipt → bench/results/handoffs.json');
process.exit(0);
