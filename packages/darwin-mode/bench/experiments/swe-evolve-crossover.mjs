// SPDX-License-Identifier: MIT
//
// ADR-137 — the antidote to ADR-136, on the real SWE substrate. ADR-136 showed a naive (1+λ)
// single-gene hill-climb traps at a local optimum (gemini/wholefile) and never reaches the
// global optimum (deepseek/searchreplace, ADR-135) because that needs TWO simultaneous gene
// changes across a noisy valley. This runs the SAME genome + corpus with a DIVERSE POPULATION +
// CROSSOVER: the population holds the `deepseek` gene (in one individual) and the `searchreplace`
// gene (in another); uniform crossover RECOMBINES them into deepseek/searchreplace in one step —
// the building-block hypothesis. Reproduces ADR-105 (diversity beats greedy on deception) on real code.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-evolve-crossover.mjs

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SPECS = [
  { id: 'kernel-js', pkg: 'kernel-js', suites: ['trajectory'],
    problem: 'The trajectory store rotateIfLarger rotates a small file and skips rotation when over the size limit — the size threshold is inverted.',
    bug: { file: 'src/trajectory.ts', from: 'if (s.size <= maxBytes) return false;', to: 'if (s.size > maxBytes) return false;' } },
  { id: 'create-agent-harness', pkg: 'create-agent-harness', suites: ['constraints'],
    problem: 'The constraints summarise function reports allHardPass true even when a hard constraint fails.',
    bug: { file: 'src/constraints.ts', from: 'allHardPass: hard.every((r) => r.passed),', to: 'allHardPass: hard.some((r) => r.passed),' } },
  { id: 'vertical-base', pkg: 'vertical-base', suites: ['base'],
    problem: 'validateVerticalManifest accepts an empty string id instead of rejecting it.',
    bug: { file: 'src/index.ts', from: "if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id must be a string');", to: "if (typeof m.id !== 'string') throw new Error('manifest.id must be a string');" } },
];

function taskFor(spec, g) {
  const root = join(PKGS, spec.pkg);
  return {
    instance_id: spec.id, problem_statement: spec.problem, test_suites: spec.suites,
    patchMode: g.patchMode, maxAttempts: g.maxAttempts, selectK: 6,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(root, f))) cpSync(join(root, f), join(work, f));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
      const p = join(work, spec.bug.file); writeFileSync(p, readFileSync(p, 'utf8').replace(spec.bug.from, spec.bug.to));
    },
  };
}

const short = (m) => m.split('/')[1];
const key = (g) => `${short(g.model)}/${g.patchMode}/a${g.maxAttempts}`;
const cache = new Map();
async function fitness(g) {
  if (cache.has(key(g))) return cache.get(key(g));
  let resolved = 0, cost = 0;
  for (const spec of SPECS) {
    let r; try { r = await runSweBenchTask(taskFor(spec, g), { model: g.model }); } catch { r = { resolved: false, cost_usd: 0 }; }
    if (r.resolved) resolved++; cost += r.cost_usd ?? 0;
  }
  const f = { genome: key(g), resolved, total: SPECS.length, cost_usd: Math.round(cost * 10000) / 10000 };
  cache.set(key(g), f); return f;
}
const better = (a, b) => (b.resolved - a.resolved) || (a.cost_usd - b.cost_usd);
// Uniform crossover: recombine genes from two parents (the building-block step).
const cross = (a, b) => [
  { model: a.model, patchMode: b.patchMode, maxAttempts: a.maxAttempts },
  { model: b.model, patchMode: a.patchMode, maxAttempts: b.maxAttempts },
];

// Gen 0: a DIVERSE population — the deepseek gene and the searchreplace gene live in
// DIFFERENT individuals (neither is the optimum), so only recombination can assemble them.
let pop = [
  { model: 'deepseek/deepseek-chat', patchMode: 'wholefile', maxAttempts: 1 },     // carries the deepseek gene
  { model: 'google/gemini-2.5-flash', patchMode: 'searchreplace', maxAttempts: 2 }, // carries the searchreplace gene
  { model: 'openai/gpt-5-mini', patchMode: 'wholefile', maxAttempts: 1 },
  { model: 'google/gemini-2.5-flash', patchMode: 'wholefile', maxAttempts: 1 },     // the ADR-136 local-optimum point
];
const trajectory = []; let elite = null;
for (let gen = 0; gen < 3; gen++) {
  const scored = [];
  for (const g of pop) scored.push({ g, f: await fitness(g) });
  scored.sort((a, b) => better(a.f, b.f));
  if (!elite || better(scored[0].f, elite.f) < 0) elite = scored[0];
  trajectory.push({ gen, elite: elite.f.genome, eliteResolved: `${elite.f.resolved}/${elite.f.total}`, eliteCost: elite.f.cost_usd, evaluatedThisGen: scored.map((s) => `${s.f.genome}:${s.f.resolved}/${s.f.total}($${s.f.cost_usd})`) });
  // Crossover the top two parents; keep elite; add offspring (the recombination step).
  const kids = cross(scored[0].g, scored[1].g).filter((k) => !cache.has(key(k)));
  if (!kids.length) break;
  pop = [elite.g, ...kids];
}

const totalCost = [...cache.values()].reduce((s, f) => s + f.cost_usd, 0);
const reachedOptimum = elite.f.genome.startsWith('deepseek-chat/searchreplace');
console.log(JSON.stringify({
  experiment: 'ADR-137 — crossover + diversity escapes the ADR-136 local optimum (real SWE substrate)',
  corpus: SPECS.map((s) => s.id), generations: trajectory.length, configsEvaluated: cache.size,
  trajectory,
  evolvedWinner: { genome: elite.f.genome, resolved: `${elite.f.resolved}/${elite.f.total}`, cost_usd: elite.f.cost_usd },
  reachedGlobalOptimum: reachedOptimum,
  totalCost_usd: Math.round(totalCost * 10000) / 10000,
  verdict: reachedOptimum
    ? `DIVERSITY+CROSSOVER WINS: recombination assembled '${elite.f.genome}' ($${elite.f.cost_usd}) from genes spread across the population — the global optimum ADR-136's greedy hill-climb could NOT reach. ADR-105 reproduced on real SWE code.`
    : `winner '${elite.f.genome}' (${elite.f.resolved}/${elite.f.total}, $${elite.f.cost_usd}) — report as measured`,
}, null, 2));
