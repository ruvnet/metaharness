// SPDX-License-Identifier: MIT
//
// ADR-125 validation: drive the consolidated `runSweBenchTask()` entry point on a
// synthetic instance, exercising the full reliable pipeline end-to-end (materialize →
// auto-derive F2P/P2P → contextBuilder select → LLM whole-file → git-diff artifact →
// real resolved criterion). This is the exact call shape an external corpus uses:
//   for (const task of dataset) await runSweBenchTask(task, { model, key });
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-bench-run.mjs [model]

import { readFileSync, cpSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUG = { file: 'src/pareto.ts', from: 'if (!dominated) front.push(items[i]);', to: 'if (dominated) front.push(items[i]);' };

// A SWE-bench-shaped task. `materialize` populates the work dir with the repo at the
// FAILING base state (real corpus tasks would `git checkout base_commit` + apply test_patch).
const task = {
  instance_id: 'synthetic__pareto-dominance',
  // bare "pareto" token so the contextBuilder selects pareto.ts (camelCase "paretoFront"
  // does not tokenise to "pareto" — see ADR-127 file-selection finding).
  problem_statement: 'The pareto module returns dominated items instead of the non-dominated front.',
  test_suites: ['pareto', 'phenotype', 'clade'],
  materialize(work) {
    for (const d of ['src', '__tests__']) cpSync(join(PKG, d), join(work, d), { recursive: true });
    cpSync(join(PKG, 'package.json'), join(work, 'package.json'));
    cpSync(join(PKG, 'tsconfig.json'), join(work, 'tsconfig.json'));
    writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
    symlinkSync(join(PKG, 'node_modules'), join(work, 'node_modules'), 'dir'); // ignored by .gitignore
    writeFileSync(join(work, BUG.file), readFileSync(join(work, BUG.file), 'utf8').replace(BUG.from, BUG.to));
  },
};

const result = await runSweBenchTask(task, { model });
console.log(JSON.stringify({
  experiment: 'ADR-125 — consolidated runSweBenchTask() entry point (corpus-ready)',
  callShape: 'for (const task of dataset) await runSweBenchTask(task, { model, key })',
  result,
  verdict: result.resolved ? 'RUNNER VALIDATED: full reliable pipeline RESOLVES the instance end-to-end' : 'inconclusive',
}, null, 2));
