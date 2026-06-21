// SPDX-License-Identifier: MIT
//
// Bench for checkpoints.ts (ADR-157 Darwin Checkpoints).
//
// Measures the real optimization: resuming a crashed run from durable checkpoints
// reuses already-paid cost-units instead of restarting from scratch. We simulate
// 100 runs, each killed mid-way, then resumed to completion, and report:
//   - costSavedPct            : cost-units saved by resume vs. restart-from-scratch
//   - reliability             : fraction of runs that complete after resume (target 1.0)
//   - maxDuplicateModelCalls  : the REAL durability guarantee — across all runs,
//                               crash + resume must issue ZERO model calls more than
//                               the uninterrupted run (the resumed prefix is never
//                               re-executed). Target 0.
// Writes a receipt to bench/results/checkpoints.json and exits 0.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CheckpointStore, runWithCheckpoints } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const policy = {
  plannerModel: 'cheap',
  coderModel: 'cheap',
  reviewerModel: 'frontier_on_failure',
  retrievalTopK: 12,
  maxRetries: 2,
  frontierEscalationThreshold: 0.78,
  securityReviewRequired: true,
  batchEval: true,
  cacheRepoContext: true,
};

const STEPS = 10;
const RUNS = 100;

function makeSteps(seed) {
  return Array.from({ length: STEPS }, (_, i) => ({
    name: `step-${i}`,
    run: (ctx) => {
      const priorN = typeof ctx.prior === 'number' ? ctx.prior : 0;
      const cost = ((seed + i) % 5) + 1; // deterministic per (seed,step)
      return {
        state: priorN + (i + 1),
        result: `r${i}`,
        fitnessDelta: i + 1,
        modelCalls: 1,
        toolCalls: 2,
        costUnits: cost,
      };
    },
  }));
}

let totalRestartCost = 0; // cost if every crashed run restarted from scratch
let totalResumeCost = 0; // cost actually paid: pre-crash + post-resume only
let completed = 0;
let maxDuplicateModelCalls = 0; // the real durability guarantee (target 0)

for (let r = 0; r < RUNS; r += 1) {
  const runId = `bench-run-${r}`;
  const steps = makeSteps(r);
  const fullCost = steps.reduce((a, s) => a + s.run({ policy, prior: 0 }).costUnits, 0);

  const crashAfter = 3 + (r % (STEPS - 4)); // vary the crash point per run

  // Ground truth: the uninterrupted run's model-call count.
  const uninterrupted = runWithCheckpoints({ runId: `${runId}-ref`, genomeId: `g-${r}`, steps, policy, store: new CheckpointStore() });

  const store = new CheckpointStore();
  const crashed = runWithCheckpoints({ runId, genomeId: `g-${r}`, steps, policy, store, crashAfter });
  const preCrashCost = crashed.checkpoints.reduce((a, c) => a + c.costUnits, 0);

  const resumed = runWithCheckpoints({ runId, genomeId: `g-${r}`, steps, policy, store });
  if (resumed.completed) completed += 1;

  // The REAL guarantee: crash + resume must issue NO MORE model calls than the
  // uninterrupted run — the checkpointed prefix is never re-executed.
  const duplicates = (crashed.modelCallsIssued + resumed.modelCallsIssued) - uninterrupted.modelCallsIssued;
  if (duplicates > maxDuplicateModelCalls) maxDuplicateModelCalls = duplicates;

  // Cost paid post-resume = checkpoints added after the crash point.
  const postResumeCost = resumed.checkpoints
    .filter((c) => c.step >= crashed.checkpoints.length)
    .reduce((a, c) => a + c.costUnits, 0);

  totalResumeCost += preCrashCost + postResumeCost;
  // Restart-from-scratch would re-pay the pre-crash work plus the full tail.
  totalRestartCost += preCrashCost + fullCost;
}

const costSavedPct = +(((totalRestartCost - totalResumeCost) / totalRestartCost) * 100).toFixed(2);
const reliability = +(completed / RUNS).toFixed(4);

console.log(`[checkpoints] runs=${RUNS} steps=${STEPS}`);
console.log(`[checkpoints] restart-from-scratch cost = ${totalRestartCost}`);
console.log(`[checkpoints] resume cost              = ${totalResumeCost}`);
console.log(`[checkpoints] cost saved by resume     = ${costSavedPct}%`);
console.log(`[checkpoints] reliability after resume = ${(reliability * 100).toFixed(1)}%`);
console.log(`[checkpoints] max duplicate model calls = ${maxDuplicateModelCalls} (target 0)`);

const receipt = { runs: RUNS, costSavedPct, reliability, maxDuplicateModelCalls };
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'checkpoints.json'), JSON.stringify(receipt, null, 2));
console.log(`[checkpoints] receipt → bench/results/checkpoints.json`);
process.exit(0);
