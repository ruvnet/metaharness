// SPDX-License-Identifier: MIT
//
// ADR-127 validation: the SEARCH/REPLACE patch primitive (Aider-style exact old→new blocks),
// now the runner default. It directly fixes ADR-126's limitation: on the SAME two-fault
// instance (a small file + a LARGE file) where whole-file rewrite regressed PASS_TO_PASS,
// surgical search/replace edits only the matched regions — so the large file is not rewritten,
// PASS_TO_PASS stays green, and both faults resolve. No JSON (ADR-126 control-char bug) and no
// line numbers (ADR-124 diff corruption): the SEARCH text is matched verbatim.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-bench-searchreplace.mjs [model]

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
  instance_id: 'synthetic__two-fault-searchreplace',
  // Terms include bare filenames (pareto, phenotype) so the contextBuilder selects both
  // buggy files — camelCase identifiers like "paretoFront" do NOT tokenise to "pareto".
  problem_statement: 'The pareto module returns dominated items instead of the non-dominated front, and the phenotype poincare distance fails to grow toward the unit-ball boundary. Fix the buggy files.',
  test_suites: ['pareto', 'phenotype', 'clade'],
  maxAttempts: 4,
  patchMode: 'searchreplace',
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
  experiment: 'ADR-127 — search/replace patch primitive (two-fault, small + large file)',
  patchMode: 'searchreplace',
  result,
  verdict: result.resolved && result.chose.length >= 2 && result.p2p === `${result.PASS_TO_PASS}/${result.PASS_TO_PASS}`
    ? `SEARCH/REPLACE VALIDATED: two-fault RESOLVED (${result.f2p} F2P, ${result.p2p} P2P — NO regression) in ${result.attemptsUsed} attempt(s), surgical edits to ${result.chose.join(', ')} — the case whole-file repair (ADR-126) could not resolve`
    : result.resolved ? `resolved (${result.f2p} F2P, ${result.p2p} P2P) in ${result.attemptsUsed} attempt(s)` : 'inconclusive',
}, null, 2));
