// SPDX-License-Identifier: MIT
//
// ADR-132 — a multi-package self-hosted SWE corpus. Extends ADR-131 (one external package)
// to a real CROSS-PACKAGE resolve-rate: one known bug in each of several monorepo packages
// (different codebases, conventions, and vitest suites), all scored by the SAME runner under
// the real resolved-criterion. This is an ADR-098-step-3-flavored result at monorepo scale —
// the honest middle ground between one external package and the full external SWE-bench corpus.
// Every package is operated on via a temp COPY; committed sources are never touched.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-monorepo-corpus.mjs [model]

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // packages/

function pkgInstance({ id, pkg, problem, suites, bug }) {
  const root = join(PKGS, pkg);
  return {
    instance_id: id, problem_statement: problem, test_suites: suites, patchMode: 'searchreplace', maxAttempts: 3,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(root, f))) cpSync(join(root, f), join(work, f));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
      const p = join(work, bug.file); const s = readFileSync(p, 'utf8');
      if (!s.includes(bug.from)) throw new Error(`bug pattern not found in ${pkg}/${bug.file}`);
      writeFileSync(p, s.replace(bug.from, bug.to));
    },
  };
}

const CORPUS = [
  pkgInstance({ id: 'kernel-js__rotate', pkg: 'kernel-js', suites: ['trajectory'],
    problem: 'The trajectory store rotateIfLarger rotates a small file and skips rotation when over the size limit — the size threshold is inverted.',
    bug: { file: 'src/trajectory.ts', from: 'if (s.size <= maxBytes) return false;', to: 'if (s.size > maxBytes) return false;' } }),
  pkgInstance({ id: 'create-agent-harness__constraints', pkg: 'create-agent-harness', suites: ['constraints'],
    problem: 'The constraints summarise function reports allHardPass true even when a hard constraint fails.',
    bug: { file: 'src/constraints.ts', from: 'allHardPass: hard.every((r) => r.passed),', to: 'allHardPass: hard.some((r) => r.passed),' } }),
  pkgInstance({ id: 'vertical-base__validate', pkg: 'vertical-base', suites: ['base'],
    problem: 'validateVerticalManifest accepts an empty string id instead of rejecting it.',
    bug: { file: 'src/index.ts', from: "if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id must be a string');", to: "if (typeof m.id !== 'string') throw new Error('manifest.id must be a string');" } }),
  pkgInstance({ id: 'darwin-mode__pareto', pkg: 'darwin-mode', suites: ['pareto'],
    problem: 'The pareto module returns dominated items instead of the non-dominated front.',
    bug: { file: 'src/pareto.ts', from: 'if (!dominated) front.push(items[i]);', to: 'if (dominated) front.push(items[i]);' } }),
];

const per = [];
let resolved = 0, cost = 0;
for (const task of CORPUS) {
  let r;
  try { r = await runSweBenchTask(task, { model }); }
  catch (e) { r = { resolved: false, f2p: 'err', p2p: 'err', attemptsUsed: 0, cost_usd: 0, error: String(e).slice(0, 120) }; }
  if (r.resolved) resolved++; cost += r.cost_usd ?? 0;
  per.push({ instance: task.instance_id, resolved: r.resolved, f2p: r.f2p, p2p: r.p2p, attempts: r.attemptsUsed, chose: r.chose, cost_usd: Math.round((r.cost_usd ?? 0) * 10000) / 10000, error: r.error });
}

console.log(JSON.stringify({
  experiment: 'ADR-132 — multi-package self-hosted SWE corpus (cross-package resolve-rate)',
  model, packages: CORPUS.length,
  resolveRate: `${resolved}/${CORPUS.length}`,
  totalCost_usd: Math.round(cost * 10000) / 10000,
  perInstance: per,
  verdict: `${resolved}/${CORPUS.length} resolved across ${new Set(CORPUS.map((t) => t.instance_id.split('__')[0])).size} packages, $${Math.round(cost * 10000) / 10000} — one runner, real resolved-criterion on each package's own vitest suite`,
}, null, 2));
