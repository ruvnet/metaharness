// SPDX-License-Identifier: MIT
// Synthetic only. Exact independent enumeration; no LLM or production savings claim.
import { assign, random, validateAssignment } from '../dist/index.js';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { platform, arch, cpus } from 'node:os';

const count = Number(process.env.ENERGY_CASES ?? 1000);
if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('ENERGY_CASES must be 1..10000');
const seed = Number(process.env.ENERGY_SEED ?? 90001);
const rng = random(seed);
const percentile = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
// All feasible permutations are enumerated. This oracle does not import energy scoring.
function exact(p) {
  let best = null, cost = Infinity;
  const used = new Set(), state = [];
  function visit(task, sum) {
    if (task === p.costs.length) {
      if (sum < cost && (p.budget === undefined || sum <= p.budget)) { best = state.slice(); cost = sum; }
      return;
    }
    for (let a = 0; a < p.costs[task].length; a++) if (!used.has(a) && p.costs[task][a] !== null) {
      used.add(a); state.push(a); visit(task + 1, sum + p.costs[task][a]); state.pop(); used.delete(a);
    }
  }
  visit(0, 0); return { state: best, cost };
}
function greedy(p) {
  const used = new Set(), state = []; let cost = 0;
  for (const row of p.costs) {
    let a = -1;
    for (let j = 0; j < row.length; j++) if (!used.has(j) && row[j] !== null && (a < 0 || row[j] < row[a])) a = j;
    if (a < 0) return { state: null, cost: Infinity };
    state.push(a); used.add(a); cost += row[a];
  }
  return validateAssignment(p, state) ? { state, cost } : { state: null, cost: Infinity };
}
const cases = Array.from({ length: count }, (_, i) => {
  const n = 3 + i % 4, c = n + (i % 3 === 0 ? 0 : 1);
  const p = { costs: Array.from({ length: n }, () => Array.from({ length: c }, () => rng() < 0.15 ? null : Math.floor(rng() * 100))) };
  const optimum = exact(p);
  // Mix tight budgets, impossible budgets and no budgets, without changing solver settings.
  if (optimum.state && i % 5 === 0) p.budget = optimum.cost;
  if (optimum.state && i % 11 === 0) p.budget = optimum.cost - 1;
  return { p, optimum: exact(p) };
});
const options = { seed: 42, maxMoves: 4000, restarts: 8, temperature: 10 };
// Explicit warm-up; cold start is timed separately and reported, not hidden.
const coldStart = performance.now(); assign(cases[0].p, options); const coldMs = performance.now() - coldStart;
for (let i = 0; i < 30; i++) assign(cases[i % count].p, options);
const data = Object.fromEntries(['greedy', 'energy_auto', 'energy_sparse', 'energy_full', 'exact'].map(k => [k,
  { latency: [], feasible: 0, optimal: 0, invalid: 0, missedFeasible: 0, gaps: [] }]));
let mismatches = 0;
for (let i = 0; i < cases.length; i++) {
  const { p, optimum } = cases[i]; const results = {};
  // Rotate execution order to reduce systematic timing bias.
  const names = Object.keys(data), order = [...names.slice(i % names.length), ...names.slice(0, i % names.length)];
  for (const name of order) {
    const start = performance.now();
    const r = name === 'greedy' ? greedy(p) : name === 'exact' ? exact(p) :
      assign(p, { ...options, incremental: name === 'energy_auto' ? undefined : name === 'energy_sparse' });
    data[name].latency.push(performance.now() - start); results[name] = r;
    const d = data[name], cost = r.score?.energy ?? r.cost;
    if (r.state) {
      d.feasible++;
      if (!validateAssignment(p, r.state)) d.invalid++;
      if (cost === optimum.cost) d.optimal++;
      if (optimum.state) d.gaps.push((cost - optimum.cost) / Math.max(1, Math.abs(optimum.cost)));
    } else if (optimum.state) d.missedFeasible++;
  }
  if (JSON.stringify(results.energy_sparse) !== JSON.stringify(results.energy_full)) mismatches++;
}
const summary = Object.fromEntries(Object.entries(data).map(([k, d]) => [k, {
  feasible: d.feasible, optimal: d.optimal, invalid: d.invalid, missedFeasible: d.missedFeasible,
  meanGap: d.gaps.length ? d.gaps.reduce((a, b) => a + b, 0) / d.gaps.length : null,
  p95Gap: d.gaps.length ? percentile(d.gaps, 0.95) : null,
  meanMs: d.latency.reduce((a, b) => a + b, 0) / count,
  p50Ms: percentile(d.latency, 0.5), p95Ms: percentile(d.latency, 0.95),
}]));
const report = {
  schemaVersion: 1, workload: 'synthetic one-task-per-agent assignment; 3..6 tasks; 15% denied pairs',
  count, seed, options, feasibleCases: cases.filter(c => c.optimum.state).length, coldMs,
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  summary, sparseFullMismatches: mismatches,
  gates: {
    zeroInvalid: Object.values(summary).every(d => d.invalid === 0),
    sparseMatchesReference: mismatches === 0,
    energyMeanGapWithinOnePercent: summary.energy_auto.meanGap !== null && summary.energy_auto.meanGap <= 0.01,
    noMissedFeasible: summary.energy_auto.missedFeasible === 0,
    twoTimesFasterThanExactP95: summary.energy_auto.p95Ms * 2 <= summary.exact.p95Ms,
  },
  limitations: ['Synthetic data, not production replay', 'No GPU, LLM or token-cost comparison',
    'Exact oracle intentionally enumerates without pruning; not a competitive optimized assignment solver',
    'Energy search is heuristic and incomplete; zero violations is not proof of optimality'],
};
console.log(JSON.stringify(report, null, 2));
if (process.env.ENERGY_REPORT) writeFileSync(process.env.ENERGY_REPORT, JSON.stringify(report, null, 2) + '\n');
if (!report.gates.zeroInvalid || !report.gates.sparseMatchesReference) process.exitCode = 1;
