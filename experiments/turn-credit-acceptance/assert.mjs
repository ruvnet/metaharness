// turn-credit-acceptance — determinism + invariant gate. Exits non-zero if:
// (a) two independent runs of the same seed differ in any byte,
// (b) two full experiment payloads differ in any canonical byte,
// (c) both arms did not face identical tasks (episode latents must match),
// (d) a signed receipt over the payload fails Ed25519 verification, or
// (e) the gate verdict is not the AND of its three clauses.
//
// HONEST BOUND: this asserts reproducibility and machinery invariants only —
// it cannot validate the synthetic environment against real RuFlo workloads.

import { CONFIG, runSeed, runExperiment, buildEnv, initialWeights, rollEpisode } from './lib.mjs';
import { makeSigner, verifyReceipt, canon } from '../../packages/flywheel/dist/receipts.js';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL: ${msg}`);
};

// (a) per-seed determinism: each seed run twice must be byte-identical.
for (const seed of CONFIG.seeds) {
  const a = JSON.stringify(runSeed(seed));
  const b = JSON.stringify(runSeed(seed));
  if (a !== b) fail(`seed ${seed}: two runs differ`);
}

// (b) full-experiment determinism (canonical bytes — what gets signed).
const p1 = runExperiment();
const p2 = runExperiment();
if (canon(p1) !== canon(p2)) fail('full experiment: two runs differ');

// (c) identical-task invariant: under the SAME (fixed) policy, both arms'
// episode streams must be byte-identical — task latents depend on the task
// seed only, never on the arm.
{
  const seed = CONFIG.seeds[0];
  const env = buildEnv(seed);
  const fixedA = Array.from({ length: CONFIG.taskTypes }, () => initialWeights());
  const fixedB = Array.from({ length: CONFIG.taskTypes }, () => initialWeights());
  for (let t = 0; t < 25; t++) {
    const ea = rollEpisode(seed, t, env, fixedA);
    const eb = rollEpisode(seed, t, env, fixedB);
    if (JSON.stringify(ea) !== JSON.stringify(eb)) fail(`task ${t}: arms saw different tasks`);
  }
}

// (d) receipt round-trip: sign the payload, verify, and reject tampering.
{
  const signer = makeSigner();
  const receipt = signer.sign(p1);
  if (!verifyReceipt(receipt)) fail('receipt: valid signature failed verification');
  const tampered = { ...receipt, payload: { ...p1, verdict: p1.verdict === 'PASS' ? 'FAIL' : 'PASS' } };
  if (verifyReceipt(tampered)) fail('receipt: tampered payload verified (must not)');
}

// (e) verdict consistency: PASS iff all three frozen clauses pass.
{
  const allPass = p1.gate.clause_lift.pass && p1.gate.clause_overhead.pass && p1.gate.clause_governance.pass;
  if ((p1.verdict === 'PASS') !== allPass) fail('verdict is not the AND of its clauses');
  if (p1.data_source !== 'SYNTHETIC') fail('data_source must be SYNTHETIC');
}

if (failures > 0) {
  console.error(`assert: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'assert: PASS — byte-identical across repeated runs; identical tasks per arm; receipt verifies (and rejects tampering); verdict = AND(clauses); data_source=SYNTHETIC'
);
