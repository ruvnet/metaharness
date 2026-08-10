// turn-credit-acceptance — runner. Executes the offline synthetic form of the
// ADR-248 §6 acceptance gate: 300 tasks × 3 seeds per arm, prints a compact
// per-seed + mean table with the three frozen gate clauses, writes a signed
// verdict.json next to this file, and exits 0 on completion REGARDLESS of the
// verdict — the verdict is data. `--check` re-runs the whole experiment and
// exits non-zero if the measurement payload differs byte-for-byte.
//
// HONEST BOUND: SYNTHETIC mechanism proof. This does NOT satisfy the §6 LIVE
// gate (real RuFlo trajectories), which remains OPEN. See README.md.
//
// Determinism note: everything printed here and the entire `payload` object
// are byte-stable across runs. The Ed25519 receipt in verdict.json is signed
// with a fresh per-process key (flywheel's makeSigner — "signing stays where
// the keys live"), so its signature/publicKey bytes legitimately differ per
// run while the SIGNED PAYLOAD is byte-identical; the receipt is verified
// in-process every run.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG, runExperiment } from './lib.mjs';
import { makeSigner, verifyReceipt, canon } from '../../packages/flywheel/dist/receipts.js';

const payload = runExperiment();

const f = (x) => x.toFixed(6);
const row = (tag, arm, r) =>
  `${String(tag).padEnd(6)} ${arm.padEnd(9)} ${f(r.completionRate).padStart(11)} ` +
  `${String(r.violations).padStart(10)} ${f(r.overhead).padStart(9)} ${f(r.arithOverhead).padStart(10)}`;

console.log('turn-credit-acceptance — offline ADR-248 §6 gate (SYNTHETIC; LIVE gate remains OPEN)');
console.log(
  `seeds=[${CONFIG.seeds.join(',')}] tasks/seed=${CONFIG.tasksPerSeed} turns=${CONFIG.minTurns}-${CONFIG.maxTurns} ` +
    `types=${CONFIG.taskTypes} (${CONFIG.usefulPerType}/${CONFIG.actions.length} actions latently useful)`
);
console.log('');
console.log(
  `${'seed'.padEnd(6)} ${'arm'.padEnd(9)} ${'completion'.padStart(11)} ${'violations'.padStart(10)} ${'overhead'.padStart(9)} ${'arith-ovh'.padStart(10)}`
);
for (const r of payload.perSeed) {
  console.log(row(r.seed, 'baseline', r.baseline));
  console.log(row(r.seed, 'credit', r.credit));
}
console.log(row('mean', 'baseline', payload.mean.baseline));
console.log(row('mean', 'credit', payload.mean.credit));
console.log('');
console.log(`lift (credit − baseline):        ${f(payload.mean.lift)}  (gate: >= ${f(CONFIG.gateLiftPp)})`);
console.log(`credit-pass overhead:            ${f(payload.mean.credit.overhead)}  (gate: <  ${f(CONFIG.gateOverheadMax)})`);
console.log(`governance-violation increase:   ${f(payload.mean.violationIncrease)}  (gate: <= 0)`);
console.log('');
for (const [name, c] of Object.entries(payload.gate)) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${name}: ${c.description} (value=${f(c.value)})`);
}
console.log('');
console.log(`GATE VERDICT: ${payload.verdict}  [data_source=SYNTHETIC — not the §6 LIVE gate]`);

// Sign the verdict payload (Ed25519, flywheel receipts) and verify in-process.
const signer = makeSigner();
const receipt = signer.sign(payload);
const verified = verifyReceipt(receipt);
console.log(`receipt: ed25519 signature over canonical payload — verified=${verified}`);
if (!verified) {
  console.error('FATAL: receipt failed in-process verification');
  process.exit(1);
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'verdict.json');
writeFileSync(outPath, JSON.stringify({ ...payload, receipt, receipt_verified: verified }, null, 2) + '\n');
console.log('wrote verdict.json (payload byte-stable; receipt key is per-process)');

if (process.argv.includes('--check')) {
  const a = canon(payload);
  const b = canon(runExperiment());
  if (a !== b) {
    console.error('DETERMINISM CHECK FAILED: two full runs differ.');
    process.exit(1);
  }
  console.log('determinism check: PASS (two full runs byte-identical)');
}
