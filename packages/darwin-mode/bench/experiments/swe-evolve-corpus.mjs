// SPDX-License-Identifier: MIT
//
// ADR-133 — the capstone: EVOLVE the harness against a real cross-package SWE fitness. Unites
// all four pillars — evolutionary engine + SWE runner + multi-package corpus (ADR-132) +
// fitness function (ADR-130). A harness genome {patchMode, maxAttempts, selectK} is scored by
// the resolved-criterion over 3 external packages; a (1+λ) evolutionary loop (elitism +
// single-gene mutation) climbs the fitness (resolve-rate primary, cost tie-break) over
// generations. This is the literal "evolve it, optimize" deliverable, end-to-end on real code.
// Bounded: 3 packages, maxAttempts ≤ 2, genome cache so the elite is not re-evaluated.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-evolve-corpus.mjs [model]

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// 3 external packages (different codebases), one known bug each.
const SPECS = [
  { id: 'kernel-js__rotate', pkg: 'kernel-js', suites: ['trajectory'],
    problem: 'The trajectory store rotateIfLarger rotates a small file and skips rotation when over the size limit — the size threshold is inverted.',
    bug: { file: 'src/trajectory.ts', from: 'if (s.size <= maxBytes) return false;', to: 'if (s.size > maxBytes) return false;' } },
  { id: 'create-agent-harness__constraints', pkg: 'create-agent-harness', suites: ['constraints'],
    problem: 'The constraints summarise function reports allHardPass true even when a hard constraint fails.',
    bug: { file: 'src/constraints.ts', from: 'allHardPass: hard.every((r) => r.passed),', to: 'allHardPass: hard.some((r) => r.passed),' } },
  { id: 'vertical-base__validate', pkg: 'vertical-base', suites: ['base'],
    problem: 'validateVerticalManifest accepts an empty string id instead of rejecting it.',
    bug: { file: 'src/index.ts', from: "if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id must be a string');", to: "if (typeof m.id !== 'string') throw new Error('manifest.id must be a string');" } },
];

function taskFor(spec, genome) {
  const root = join(PKGS, spec.pkg);
  return {
    instance_id: spec.id, problem_statement: spec.problem, test_suites: spec.suites,
    patchMode: genome.patchMode, maxAttempts: genome.maxAttempts, selectK: genome.selectK,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(root, f))) cpSync(join(root, f), join(work, f));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
      const p = join(work, spec.bug.file); writeFileSync(p, readFileSync(p, 'utf8').replace(spec.bug.from, spec.bug.to));
    },
  };
}

const key = (g) => `${g.patchMode}/a${g.maxAttempts}/k${g.selectK}`;
const cache = new Map();
async function fitness(g) {
  if (cache.has(key(g))) return cache.get(key(g));
  let resolved = 0, cost = 0;
  for (const spec of SPECS) {
    let r; try { r = await runSweBenchTask(taskFor(spec, g), { model }); } catch { r = { resolved: false, cost_usd: 0 }; }
    if (r.resolved) resolved++; cost += r.cost_usd ?? 0;
  }
  const f = { genome: key(g), resolved, total: SPECS.length, cost_usd: Math.round(cost * 10000) / 10000 };
  cache.set(key(g), f); return f;
}
// Fitness order: maximize resolved, then minimize cost.
const better = (a, b) => (b.resolved - a.resolved) || (a.cost_usd - b.cost_usd);

// Single-gene neighbours (the mutation operator).
function neighbours(g) {
  return [
    { ...g, patchMode: g.patchMode === 'searchreplace' ? 'wholefile' : 'searchreplace' },
    { ...g, maxAttempts: g.maxAttempts === 1 ? 2 : 1 },
    { ...g, selectK: g.selectK === 3 ? 6 : 3 },
  ];
}

// Gen 0: a diverse population, none of them the known-good config.
let pop = [
  { patchMode: 'wholefile', maxAttempts: 1, selectK: 6 },
  { patchMode: 'searchreplace', maxAttempts: 1, selectK: 3 },
  { patchMode: 'wholefile', maxAttempts: 2, selectK: 3 },
];
const trajectory = [];
let elite = null;
for (let gen = 0; gen < 3; gen++) {
  const scored = [];
  for (const g of pop) scored.push({ g, f: await fitness(g) });
  scored.sort((a, b) => better(a.f, b.f));
  const genBest = scored[0];
  if (!elite || better(genBest.f, elite.f) < 0) elite = genBest;
  trajectory.push({ gen, evaluated: scored.map((s) => s.f), best: genBest.f });
  // Next gen: elite + its unevaluated single-gene neighbours (the (1+λ) step).
  const fresh = neighbours(elite.g).filter((n) => !cache.has(key(n)));
  if (!fresh.length) break;
  pop = fresh.slice(0, 2);
}

const totalCost = [...cache.values()].reduce((s, f) => s + f.cost_usd, 0);
console.log(JSON.stringify({
  experiment: 'ADR-133 — evolve the harness against a real cross-package SWE fitness',
  model, corpus: SPECS.map((s) => s.id), genome: 'patchMode × maxAttempts × selectK',
  generations: trajectory.length, configsEvaluated: cache.size,
  trajectory: trajectory.map((t) => ({ gen: t.gen, bestGenome: t.best.genome, bestResolved: `${t.best.resolved}/${t.best.total}`, bestCost: t.best.cost_usd })),
  evolvedWinner: { genome: elite.f.genome, resolved: `${elite.f.resolved}/${elite.f.total}`, cost_usd: elite.f.cost_usd },
  totalCost_usd: Math.round(totalCost * 10000) / 10000,
  verdict: `EVOLVED: best genome '${elite.f.genome}' (${elite.f.resolved}/${elite.f.total} resolved, $${elite.f.cost_usd}) — fitness = cross-package resolve-rate over real external code, climbed by elitism + single-gene mutation`,
}, null, 2));
