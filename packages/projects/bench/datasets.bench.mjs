// SPDX-License-Identifier: MIT
//
// Bench for datasets.ts (ADR-162 DarwinBench Dataset Registry).
//
// Builds a registry with all four splits, then runs the real optimization — the
// four-split promotion gate — against (a) a true winner that beats baseline on every
// split and (b) a train-overfit false winner that ties on the adversarial split. It
// prints each per-split lower95 and the promote decision, proving the gate kills the
// false winner. Writes bench/results/datasets.json and exits 0.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatasetRegistry, fourSplitGate } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 2026;
const SPLITS = ['train', 'heldout', 'regression', 'adversarial'];
const PER = 40;

const reg = new DatasetRegistry();
for (const split of SPLITS) {
  for (let i = 0; i < PER; i += 1) {
    reg.add({ id: `${split}-${i}`, split, provenance: 'accepted-pr', input: i, label: i % 2 });
  }
}

// Baseline scorer with mild per-example variance.
const incumbent = (ex) => 0.5 + ((Number(ex.input) % 5) - 2) * 0.02;

// (a) True winner: uniformly +0.1 on every split.
const trueWinner = (ex) => incumbent(ex) + 0.1;

// (b) False winner: overfits `train` (+0.2) but ties incumbent on `adversarial`.
const falseWinner = (ex) => {
  if (ex.split === 'train') return incumbent(ex) + 0.2;
  if (ex.split === 'adversarial') return incumbent(ex);
  return incumbent(ex) + 0.05;
};

const vTrue = fourSplitGate(reg, incumbent, trueWinner, { seed: SEED });
const vFalse = fourSplitGate(reg, incumbent, falseWinner, { seed: SEED });

const lower = (v) => SPLITS.map((s) => `${s}=${v.perSplit[s].lower95}`).join(' ');

console.log(`[datasets] provenanceComplete=${reg.provenanceComplete()} splits=${reg.splits().join(',')}`);
console.log(`[datasets] true-winner  lower95: ${lower(vTrue)}`);
console.log(`[datasets] true-winner  promote=${vTrue.promote} passed=[${vTrue.passedSplits.join(',')}]`);
console.log(`[datasets] false-winner lower95: ${lower(vFalse)}`);
console.log(`[datasets] false-winner promote=${vFalse.promote} passed=[${vFalse.passedSplits.join(',')}]`);

if (vTrue.promote !== true || vFalse.promote !== false) {
  console.error('[datasets] GATE FAILED: expected true→promote, false→reject');
  process.exit(1);
}

const receipt = {
  trueWinnerPromoted: vTrue.promote,
  falseWinnerPromoted: vFalse.promote,
  perSplit: {
    trueWinner: Object.fromEntries(SPLITS.map((s) => [s, vTrue.perSplit[s].lower95])),
    falseWinner: Object.fromEntries(SPLITS.map((s) => [s, vFalse.perSplit[s].lower95])),
  },
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'datasets.json'), JSON.stringify(receipt, null, 2));
console.log('[datasets] receipt → bench/results/datasets.json');
process.exit(0);
