// credit-feedback replay — runner. Prints a compact per-seed + mean table for
// both feedback arms (uniform weight=1 vs credit-weighted toMemoryFeedback
// multipliers) and exits 0. `--check` additionally re-runs every seed and
// exits non-zero if any result differs byte-for-byte (determinism gate).
//
// HONEST BOUND: synthetic mechanism testbed — the construction favors the
// credit arm by design (see lib.mjs header and README.md). Numbers here are
// evidence about the plumbing, not about real retrieval corpora.

import { CONFIG, runExperiment } from './lib.mjs';

const result = runExperiment();

const f = (x) => x.toFixed(6);
const row = (tag, arm, r) =>
  `${String(tag).padEnd(6)} ${arm.padEnd(8)} ${f(r.hit1).padStart(9)} ${f(r.hit3).padStart(9)} ${f(r.recall3).padStart(9)}`;

console.log('credit-feedback replay — credit-weighted vs uniform retrieval feedback');
console.log(
  `seeds=[${CONFIG.seeds.join(',')}] trajectories/seed=${CONFIG.trajectoriesPerSeed} ` +
    `pools=${CONFIG.queries} (2 helpful + ${CONFIG.distractorsPerQuery} distractors each)`
);
console.log('');
console.log(`${'seed'.padEnd(6)} ${'arm'.padEnd(8)} ${'hit@1'.padStart(9)} ${'hit@3'.padStart(9)} ${'recall@3'.padStart(9)}`);
for (const r of result.perSeed) {
  console.log(row(r.seed, 'uniform', r.uniform));
  console.log(row(r.seed, 'credit', r.credit));
}
console.log(row('mean', 'uniform', result.mean.uniform));
console.log(row('mean', 'credit', result.mean.credit));
console.log('');
console.log(`mean trajectory success rate: ${f(result.mean.successRate)}`);

if (process.argv.includes('--check')) {
  const a = JSON.stringify(result);
  const b = JSON.stringify(runExperiment());
  if (a !== b) {
    console.error('DETERMINISM CHECK FAILED: two runs of the same seeds differ.');
    process.exit(1);
  }
  console.log('determinism check: PASS (two full runs byte-identical)');
}
