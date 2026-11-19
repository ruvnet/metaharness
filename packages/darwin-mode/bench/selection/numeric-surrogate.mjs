#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Numeric-genome surrogate pre-screen benchmark.
//
// Question: at the same external-evaluator budget PER PARENT, does ranking an
// oversampled candidate pool with the ruv-fann surrogate reach a better
// `primary` than the unscreened loop? (Total evaluations are reported too:
// a run that promotes more often carries two parents more often, so totals
// differ by a few percent.)
//
// Method: paired runs (same seed, same objective, same budget) of
// `evolveNumeric` with and without the surrogate, over SEEDS seeds and three
// synthetic objectives with a known optimum of 0. Reports the mean final
// regret (0 − best primary; lower is better), the paired win/tie/loss count
// and a two-sided sign-test p-value (uncorrected — the table makes many
// comparisons, so read single small p-values with that in mind). Deterministic: rerunning prints the same
// table. Synthetic objectives only — this measures the search mechanism, not
// any real training workload.
//
//   npm run bench:surrogate            (needs the optional peer ruv-fann)
//   node bench/selection/numeric-surrogate.mjs --seeds 40 --generations 10 --children 4

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFannSurrogate, evolveNumeric } from '../../dist/index.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const SEEDS = arg('--seeds', 100);
const GENERATIONS = arg('--generations', 10);
const CHILDREN = arg('--children', 4);
const DIMS = arg('--dims', 6);

const names = Array.from({ length: DIMS }, (_, i) => `p${i}`);
const spec = Object.fromEntries(names.map((n) => [n, { min: 0, max: 1, scale: 'linear', type: 'float', default: 0.5 }]));
// Optimum away from the baseline midpoint, different per dimension.
const optimum = names.map((_, i) => 0.15 + (0.7 * ((i * 7) % DIMS)) / Math.max(1, DIMS - 1));

const OBJECTIVES = {
  // Separable bowl.
  sphere: (v) => -v.reduce((s, x, i) => s + (x - optimum[i]) ** 2, 0),
  // Ill-conditioned: per-dimension curvature spans 100x.
  ellipsoid: (v) => -v.reduce((s, x, i) => s + 10 ** ((2 * i) / Math.max(1, DIMS - 1)) * (x - optimum[i]) ** 2, 0) / 10,
  // Non-separable: neighbouring parameters interact.
  coupled: (v) => {
    const d = v.map((x, i) => x - optimum[i]);
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] ** 2 + (i + 1 < d.length ? d[i] * d[i + 1] : 0);
    return -s;
  },
};

// [model options, pre-screen options]
const VARIANTS = {
  defaults: [{}, {}],
  'ensemble=4': [{ ensemble: 4 }, {}],
  'ensemble=4, explorationWeight=1': [{ ensemble: 4, explorationWeight: 1 }, {}],
  'ensemble=4, oversample=8': [{ ensemble: 4 }, { oversample: 8 }],
  'ensemble=4, exploreSlots=0': [{ ensemble: 4 }, { exploreSlots: 0 }],
  'ensemble=4, minRows=6': [{ ensemble: 4 }, { minRows: 6 }],
};

function signTestP(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  let c = 1; // C(n, i)
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

async function run(objective, seed, surrogate) {
  const dir = await mkdtemp(join(tmpdir(), 'darwin-surrogate-bench-'));
  let calls = 0;
  try {
    const result = await evolveNumeric({
      genomeSpec: spec,
      evaluator: {
        async evaluate(genome, variantId) {
          calls += 1;
          return { variantId, primary: objective(names.map((n) => genome[n])), regressed: false, noopRate: 0, costPerWin: 0 };
        },
      },
      generations: GENERATIONS,
      childrenPerGeneration: CHILDREN,
      seed,
      workRoot: dir,
      surrogate,
    });
    return { regret: -result.winner.score.primary, calls, screened: result.surrogate?.generationsScreened ?? 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rows = [];
for (const [objectiveName, objective] of Object.entries(OBJECTIVES)) {
  const plain = [];
  for (let seed = 0; seed < SEEDS; seed++) plain.push(await run(objective, seed, undefined));
  for (const [variantName, [modelOptions, screenOptions]] of Object.entries(VARIANTS)) {
    const guided = [];
    for (let seed = 0; seed < SEEDS; seed++) {
      const model = await createFannSurrogate({ ...modelOptions, seed });
      try {
        guided.push(await run(objective, seed, { model, ...screenOptions }));
      } finally {
        model.dispose();
      }
    }
    let wins = 0;
    let losses = 0;
    for (let i = 0; i < SEEDS; i++) {
      if (guided[i].regret < plain[i].regret) wins += 1;
      else if (guided[i].regret > plain[i].regret) losses += 1;
    }
    const change = (mean(guided.map((r) => r.regret)) / mean(plain.map((r) => r.regret)) - 1) * 100;
    rows.push({
      objective: objectiveName,
      surrogate: variantName,
      'plain regret': mean(plain.map((r) => r.regret)).toFixed(4),
      'guided regret': mean(guided.map((r) => r.regret)).toFixed(4),
      'regret change': `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`,
      'win/tie/loss': `${wins}/${SEEDS - wins - losses}/${losses}`,
      'sign-test p': signTestP(wins, losses).toFixed(4),
      'evals plain/guided': `${mean(plain.map((r) => r.calls))}/${mean(guided.map((r) => r.calls))}`,
      'gens screened': mean(guided.map((r) => r.screened)).toFixed(1),
    });
  }
}
console.log(`evolveNumeric surrogate pre-screen — ${SEEDS} paired seeds, ${DIMS} params, ${GENERATIONS} generations × ${CHILDREN} children/parent`);
console.table(rows);
