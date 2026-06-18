// SPDX-License-Identifier: MIT
//
// ADR-130 — runSweBenchTask as a FITNESS FUNCTION for harness optimization. The whole SWE
// runner (123–129) exists so the harness can be SCORED on real tasks. This closes the loop:
// a small config population is evaluated by the real resolved-criterion over a 2-instance
// corpus (a SMALL file + the LARGE file), and the SWE resolve-rate (tie-break: cost) selects
// the best configuration — exactly the signal evolve() would optimize over surfaces at scale.
//
// Single-generation, fitness-driven selection (the bridge to multi-generational surface
// evolution, which at LLM scale is the budget-gated ADR-098 step 3). Bounded cost.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-fitness-selection.mjs [model]

import { readFileSync, cpSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function instance(id, problem, suites, bug) {
  return {
    instance_id: id, problem_statement: problem, test_suites: suites,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(PKG, d), join(work, d), { recursive: true });
      cpSync(join(PKG, 'package.json'), join(work, 'package.json'));
      cpSync(join(PKG, 'tsconfig.json'), join(work, 'tsconfig.json'));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(PKG, 'node_modules'), join(work, 'node_modules'), 'dir');
      const p = join(work, bug.file); writeFileSync(p, readFileSync(p, 'utf8').replace(bug.from, bug.to));
    },
  };
}

// 2-instance corpus: one SMALL file, one LARGE file (the regression-prone case).
const CORPUS = [
  instance('pareto-small', 'The pareto module returns dominated items instead of the non-dominated front.', ['pareto'],
    { file: 'src/pareto.ts', from: 'if (!dominated) front.push(items[i]);', to: 'if (dominated) front.push(items[i]);' }),
  instance('phenotype-large', 'The phenotype poincare distance fails to grow toward the unit-ball boundary.', ['phenotype'],
    { file: 'src/phenotype.ts', from: 'return Math.acosh(1 + (2 * diff2) / denom);', to: 'return Math.acosh(1 + (2 * diff2) * denom);' }),
];

// Config population (the genotype): patch primitive × repair budget.
const CONFIGS = [
  { name: 'wholefile/1', patchMode: 'wholefile', maxAttempts: 1 },
  { name: 'wholefile/3', patchMode: 'wholefile', maxAttempts: 3 },
  { name: 'searchreplace/3', patchMode: 'searchreplace', maxAttempts: 3 },
];

const results = [];
for (const cfg of CONFIGS) {
  let resolved = 0, cost = 0; const per = [];
  for (const base of CORPUS) {
    const task = { ...base, patchMode: cfg.patchMode, maxAttempts: cfg.maxAttempts };
    const r = await runSweBenchTask(task, { model });
    if (r.resolved) resolved++; cost += r.cost_usd ?? 0;
    per.push({ instance: base.instance_id, resolved: r.resolved, f2p: r.f2p, p2p: r.p2p, attempts: r.attemptsUsed });
  }
  results.push({ config: cfg.name, resolveRate: `${resolved}/${CORPUS.length}`, resolved, cost_usd: Math.round(cost * 10000) / 10000, per });
}

// Fitness: maximize resolve count, tie-break minimize cost.
const ranked = [...results].sort((a, b) => (b.resolved - a.resolved) || (a.cost_usd - b.cost_usd));
const winner = ranked[0];
console.log(JSON.stringify({
  experiment: 'ADR-130 — SWE resolve-rate as a fitness function for harness selection',
  corpus: CORPUS.map((c) => c.instance_id), configsEvaluated: CONFIGS.length, model,
  landscape: results,
  winner: winner.config,
  verdict: `FITNESS-SELECTED: '${winner.config}' wins (resolveRate ${winner.resolveRate}, $${winner.cost_usd}) — the SWE resolved-criterion ranks harness configs; evolve() optimizes this signal`,
}, null, 2));
