// credit-feedback replay — determinism + invariant gate. Exits non-zero if
// (a) two independent runs of the same seed differ in any byte of their
// canonical JSON, or (b) any credit-arm feedback weight escapes the paper
// bound m_k ∈ [1−λ·b, 1+λ·b] = [0.75, 1.25].
//
// HONEST BOUND: this asserts reproducibility and the safety invariant only —
// it does not (and cannot) validate the synthetic construction against real
// retrieval workloads.

import {
  CONFIG,
  runSeed,
  runExperiment,
  buildIndex,
  genTrajectory,
  mulberry32,
} from './lib.mjs';
import {
  processTrajectory,
  evidenceFromScorePairs,
  toMemoryFeedback,
  PAPER_DEFAULTS,
} from '../../packages/turn-credit/dist/index.js';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL: ${msg}`);
};

// (a) determinism: each seed run twice must be byte-identical; so must the
// full experiment.
for (const seed of CONFIG.seeds) {
  const a = JSON.stringify(runSeed(seed));
  const b = JSON.stringify(runSeed(seed));
  if (a !== b) fail(`seed ${seed}: two runs differ`);
}
if (JSON.stringify(runExperiment()) !== JSON.stringify(runExperiment())) {
  fail('full experiment: two runs differ');
}

// (b) bound invariant: every credit-arm weight stays inside [0.75, 1.25].
{
  const rng = mulberry32(CONFIG.seeds[0]);
  const index = buildIndex(rng);
  for (let t = 0; t < 20; t++) {
    const { pairs, retrievedIdsByTurn, success } = genTrajectory(
      rng,
      index.pools[t % CONFIG.queries],
      index.skills
    );
    const credit = processTrajectory({
      evidence: evidenceFromScorePairs(pairs, CONFIG.evidenceScale),
      mode: 'verifier-delta-proxy',
      prior: CONFIG.prior,
      success,
      config: PAPER_DEFAULTS,
    });
    for (const r of toMemoryFeedback(credit, retrievedIdsByTurn)) {
      if (!(r.weight >= 0.75 - 1e-9 && r.weight <= 1.25 + 1e-9)) {
        fail(`weight ${r.weight} escapes [0.75, 1.25]`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`assert: ${failures} failure(s)`);
  process.exit(1);
}
console.log('assert: PASS — deterministic across repeated runs; weights within ±25% bound');
