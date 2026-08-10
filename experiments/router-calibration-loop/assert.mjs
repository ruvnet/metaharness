// router-calibration-loop — determinism + invariant gate. Exits non-zero if:
//  (a) two independent runs of any seed (or the full experiment) differ in any
//      byte of their canonical JSON;
//  (b) any quality label of either arm escapes [0,1], or any credit-arm
//      multiplier escapes the paper bound m_k ∈ [1−λ·b, 1+λ·b] = [0.75, 1.25];
//  (c) the calibration audits do not cover exactly evalTasks × 2 candidates;
//  (d) the result is not stamped data_source 'SYNTHETIC'.
//
// HONEST BOUND: this asserts reproducibility and structural invariants only —
// it does not (and cannot) validate the synthetic construction against real
// routing workloads, and it does NOT constitute the ADR-248 §6 LIVE gate.

import { CONFIG, mulberry32, drawTask, genEpisode, labelEpisode, runSeed, runExperiment } from './lib.mjs';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL: ${msg}`);
};

// (a) determinism: every seed run twice must be byte-identical; so must the
// full experiment.
for (const seed of CONFIG.seeds) {
  const a = JSON.stringify(runSeed(seed));
  const b = JSON.stringify(runSeed(seed));
  if (a !== b) fail(`seed ${seed}: two runs differ`);
}
const r1 = runExperiment();
const r2 = runExperiment();
if (JSON.stringify(r1) !== JSON.stringify(r2)) fail('full experiment: two runs differ');

// (b) label + bound invariants on a fresh sample of episodes.
{
  const rng = mulberry32(CONFIG.seeds[0]);
  for (let i = 0; i < 25; i++) {
    const task = drawTask(rng);
    for (const modelId of ['cheap', 'frontier']) {
      const ep = genEpisode(rng, task, modelId);
      const { naive, credited, credit } = labelEpisode(ep);
      for (const ex of naive) {
        if (!(ex.quality === 0 || ex.quality === 1)) fail(`naive label ${ex.quality} not 0/1`);
      }
      for (const ex of credited) {
        if (!(ex.quality >= 0 && ex.quality <= 1)) fail(`credit label ${ex.quality} escapes [0,1]`);
      }
      for (const c of credit.credits) {
        if (!(c.multiplier >= 0.75 - 1e-9 && c.multiplier <= 1.25 + 1e-9)) {
          fail(`multiplier ${c.multiplier} escapes [0.75, 1.25]`);
        }
      }
      if (naive.length !== CONFIG.turns || credited.length !== CONFIG.turns) {
        fail('per-episode example count != turns');
      }
    }
  }
}

// (c) calibration audit coverage: evalTasks × 2 candidates per arm, per seed.
for (const r of r1.perSeed) {
  for (const arm of ['naive', 'credit']) {
    if (r.calibration[arm].samples !== CONFIG.evalTasks * 2) {
      fail(`seed ${r.seed} ${arm}: calibration samples ${r.calibration[arm].samples} != ${CONFIG.evalTasks * 2}`);
    }
  }
}

// (d) honesty stamp.
if (r1.data_source !== 'SYNTHETIC') fail(`data_source '${r1.data_source}' != 'SYNTHETIC'`);

if (failures > 0) {
  console.error(`assert: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'assert: PASS — deterministic across repeated runs; labels in [0,1]; multipliers within ±25% bound; SYNTHETIC stamp present'
);
