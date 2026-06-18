// SPDX-License-Identifier: MIT
//
// ADR-126 validation: the iterative REPAIR LOOP in runSweBenchTask. A two-fault instance
// (bugs in TWO files) that a single whole-file fix cannot resolve — the model fixes one
// file per attempt, and the runner feeds the still-failing tests + assertion messages back
// so the next attempt fixes the remaining file. Demonstrates repair lifts a partial fix to
// a full resolve (and that the criterion correctly withholds RESOLVED until all F2P pass).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-bench-repair.mjs [model]

import { readFileSync, cpSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUGS = [
  { file: 'src/pareto.ts', from: 'if (!dominated) front.push(items[i]);', to: 'if (dominated) front.push(items[i]);' },
  { file: 'src/phenotype.ts', from: 'return Math.acosh(1 + (2 * diff2) / denom);', to: 'return Math.acosh(1 + (2 * diff2) * denom);' },
];

const task = {
  instance_id: 'synthetic__two-fault',
  problem_statement: 'Two modules have bugs: paretoFront returns dominated items instead of the non-dominated front, and poincareDistance fails to grow toward the Poincaré-ball boundary. Fix the buggy file(s).',
  test_suites: ['pareto', 'phenotype', 'clade'],
  maxAttempts: 4,
  patchMode: 'wholefile', // ADR-126 documents the whole-file limitation; ADR-127 default is searchreplace
  materialize(work) {
    for (const d of ['src', '__tests__']) cpSync(join(PKG, d), join(work, d), { recursive: true });
    cpSync(join(PKG, 'package.json'), join(work, 'package.json'));
    cpSync(join(PKG, 'tsconfig.json'), join(work, 'tsconfig.json'));
    writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
    symlinkSync(join(PKG, 'node_modules'), join(work, 'node_modules'), 'dir');
    for (const bug of BUGS) {
      const p = join(work, bug.file); const s = readFileSync(p, 'utf8');
      if (!s.includes(bug.from)) throw new Error(`bug pattern not found in ${bug.file}`);
      writeFileSync(p, s.replace(bug.from, bug.to));
    }
  },
};

const result = await runSweBenchTask(task, { model });
console.log(JSON.stringify({
  experiment: 'ADR-126 — iterative repair loop (two-fault instance)',
  result,
  verdict: result.resolved && result.attemptsUsed >= 2 && result.chose.length >= 2
    ? `REPAIR VALIDATED: two-fault instance RESOLVED in ${result.attemptsUsed} attempts (single shot cannot — fixed ${result.chose.join(', ')})`
    : result.resolved && result.attemptsUsed === 1
      ? 'resolved in 1 attempt (model fixed both files at once — repair loop available but not needed this run)'
      : 'inconclusive',
}, null, 2));
