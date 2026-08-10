// router-calibration-loop — runner. Compact per-seed + mean tables for both
// labeling arms (naive terminal 0/1 vs turn-credit toQualityLabels), a
// diagnostics block explaining WHY the numbers land where they do, and
// per-claim verdicts. `--check` re-runs everything and exits non-zero if any
// byte differs (determinism gate).
//
// HONEST BOUND: synthetic mechanism testbed (see lib.mjs header + README.md).
// data_source: SYNTHETIC. Not the ADR-248 §6 LIVE acceptance gate.

import { CONFIG, runExperiment } from './lib.mjs';

const result = runExperiment();

const f = (x) => x.toFixed(6);
console.log('router-calibration-loop — turn-credit labels vs naive 0/1 labels [SYNTHETIC]');
console.log(
  `seeds=[${CONFIG.seeds.join(',')}] trainTasks=${CONFIG.trainTasks} evalTasks=${CONFIG.evalTasks} ` +
    `turns=${CONFIG.turns} k=${CONFIG.k} qualityBar=${CONFIG.qualityBar}`
);

console.log('\n== calibration (held-out predictedQuality vs realized 0/1; lower is better) ==');
console.log(`${'seed'.padEnd(6)} ${'arm'.padEnd(8)} ${'ECE'.padStart(10)} ${'Brier'.padStart(10)}`);
for (const r of result.perSeed) {
  console.log(`${String(r.seed).padEnd(6)} ${'naive'.padEnd(8)} ${f(r.calibration.naive.ece).padStart(10)} ${f(r.calibration.naive.brier).padStart(10)}`);
  console.log(`${''.padEnd(6)} ${'credit'.padEnd(8)} ${f(r.calibration.credit.ece).padStart(10)} ${f(r.calibration.credit.brier).padStart(10)}`);
}
console.log(`${'mean'.padEnd(6)} ${'naive'.padEnd(8)} ${f(result.mean.calibration.naive.ece).padStart(10)} ${f(result.mean.calibration.naive.brier).padStart(10)}`);
console.log(`${''.padEnd(6)} ${'credit'.padEnd(8)} ${f(result.mean.calibration.credit.ece).padStart(10)} ${f(result.mean.calibration.credit.brier).padStart(10)}`);
console.log(`${''.padEnd(6)} ${'oracle*'.padEnd(8)} ${f(result.mean.calibration.oracle.ece).padStart(10)} ${f(result.mean.calibration.oracle.brier).padStart(10)}  (*true latent p — reference, not an arm)`);

console.log(`\n== economics (route ${CONFIG.evalTasks} held-out tasks at qualityBar=${CONFIG.qualityBar}; common random numbers) ==`);
console.log(`${'seed'.padEnd(6)} ${'arm'.padEnd(8)} ${'cost($)'.padStart(10)} ${'quality'.padStart(9)} ${'cheap%'.padStart(8)} ${'metBar%'.padStart(8)}`);
const econRow = (tag, arm, e) =>
  `${String(tag).padEnd(6)} ${arm.padEnd(8)} ${f(e.cost).padStart(10)} ${f(e.realizedQuality).padStart(9)} ${f(e.cheapShare).padStart(8)} ${f(e.metBarShare).padStart(8)}`;
for (const r of result.perSeed) {
  console.log(econRow(r.seed, 'naive', r.econ.naive));
  console.log(econRow('', 'credit', r.econ.credit));
}
console.log(econRow('mean', 'naive', result.mean.econ.naive));
console.log(econRow('', 'credit', result.mean.econ.credit));
console.log(
  `refs   always-cheap    cost=${f(result.mean.refs['always-cheap'].cost)} quality=${f(result.mean.refs['always-cheap'].realizedQuality)}` +
    ` | always-frontier cost=${f(result.mean.refs['always-frontier'].cost)} quality=${f(result.mean.refs['always-frontier'].realizedQuality)}`
);

console.log('\n== diagnostics (why): credit labels are within-trajectory RELATIVE ==');
for (const r of result.perSeed) {
  const d = r.diagnostics;
  console.log(
    `seed ${String(r.seed).padEnd(4)} creditLabel mean work=${f(d.creditLabelMeanWorkTurns)} distractor=${f(d.creditLabelMeanDistractorTurns)} ` +
      `successTraj=${f(d.creditLabelMeanSuccessTraj)} failTraj=${f(d.creditLabelMeanFailTraj)}`
  );
  console.log(
    `          prediction mean/sd naive=${f(d.predictionMean.naive)}/${f(d.predictionSd.naive)} ` +
      `credit=${f(d.predictionMean.credit)}/${f(d.predictionSd.credit)} trainSuccessRate=${f(d.trainSuccessRate)}`
  );
}

console.log('\n== claims ==');
const verdict = (v) => (v ? 'SUPPORTED' : 'REFUTED');
const seedMarks = (xs) => xs.map((x) => (x ? 'pass' : 'fail')).join(',');
console.log(
  `claim 1 (credit ECE < naive ECE):                        ${verdict(result.verdicts.calibration.onMeans)}` +
    `  [per-seed: ${seedMarks(result.verdicts.calibration.perSeed)}]`
);
console.log(
  `claim 2 (credit cost <= naive at equal-or-better quality): ${verdict(result.verdicts.economics.onMeans)}` +
    `  [per-seed: ${seedMarks(result.verdicts.economics.perSeed)}]`
);
console.log('\ndata_source: SYNTHETIC — mechanism evidence only; see README "Honest bounds".');

if (process.argv.includes('--check')) {
  const a = JSON.stringify(result);
  const b = JSON.stringify(runExperiment());
  if (a !== b) {
    console.error('DETERMINISM CHECK FAILED: two runs of the same seeds differ.');
    process.exit(1);
  }
  console.log('determinism check: PASS (two full runs byte-identical)');
}
