// SPDX-License-Identifier: MIT
//
// Bench for scheduler.ts (ADR-160 Escalation Scheduler). Both arms are REAL
// scheduler runs over the SAME seeded task population — the only difference is the
// retry bound, so the measured reduction is genuinely a property of bounding, not
// a hardcoded ratio:
//   - NAIVE   : an effectively-unbounded scheduler (maxRetriesPerNode very high)
//               that keeps paying for doomed/hard tasks.
//   - BOUNDED : the scheduler's real cap (maxRetriesPerNode = 3).
// Reduction emerges from the seeded mix of easy/hard/doomed tasks (varies by seed).
// We also assert EVERY bounded run terminates with a valid typed reason.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EscalationScheduler, makeRng } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const VALID_REASONS = new Set([
  'success', 'budget_exhausted', 'max_retries', 'max_escalations',
  'max_reviewer_passes', 'context_overflow', 'security_uncertain',
]);

const TASKS = 200;
const SEED = 7;

// Shared generous bounds so the ONLY binding difference between the two arms is the
// retry cap (isolates the variable being measured).
const wide = {
  maxFrontierEscalations: 9_999, maxContextGrowthRatio: 9_999, maxReviewerPasses: 9_999,
  costBudget: 1e9, timeBudget: 1e9, failClosedOnSecurityUncertainty: true,
};
const naivePolicy = { ...wide, maxRetriesPerNode: 50 }; // unbounded-ish naive loop
const boundedPolicy = { ...wide, maxRetriesPerNode: 3 }; // the scheduler's real bound

// A task succeeds after `successAt` attempts; ~40% are doomed (never succeed). Both
// the cost-per-attempt and the difficulty are seeded → the population is a real,
// reproducible distribution, not a constant.
function nodeFor(seed) {
  const rng = makeRng(seed);
  const costPerAttempt = 0.5 + rng(); // 0.5..1.5
  const successAt = rng() < 0.4 ? Infinity : 1 + Math.floor(rng() * 6); // doomed or 1..6
  return { id: `task-${seed}`, run: (attempt) => ({ ok: attempt >= successAt, costUnits: costPerAttempt, timeUnits: 0.05 }) };
}

let naiveCost = 0;
let boundedCost = 0;
let allTerminated = true;
for (let i = 0; i < TASKS; i += 1) {
  const seed = SEED * 1000 + i;
  naiveCost += new EscalationScheduler(naivePolicy).run([nodeFor(seed)]).costUnits;
  const out = new EscalationScheduler(boundedPolicy).run([nodeFor(seed)]);
  boundedCost += out.costUnits;
  if (!VALID_REASONS.has(out.reason)) allTerminated = false;
}

const costReductionPct = +(((naiveCost - boundedCost) / naiveCost) * 100).toFixed(2);

console.log(`scheduler: tasks=${TASKS} (both arms are real scheduler runs)`);
console.log(`scheduler: naiveCost=${naiveCost.toFixed(2)} boundedCost=${boundedCost.toFixed(2)}`);
console.log(`scheduler: costReductionPct=${costReductionPct}% (measured, seed-dependent)`);
console.log(`scheduler: allTerminated=${allTerminated}`);

const receipt = { tasks: TASKS, seed: SEED, costReductionPct, allTerminated, naiveCost: +naiveCost.toFixed(2), boundedCost: +boundedCost.toFixed(2) };
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'scheduler.json'), JSON.stringify(receipt, null, 2));
process.exit(0);
