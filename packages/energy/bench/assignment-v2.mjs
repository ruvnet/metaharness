// SPDX-License-Identifier: MIT
// Synthetic matching benchmark. Oracle and validation deliberately do not use
// library scoring. Timings are amortized warm CPU calls, not service latency.
import { assign, random } from '../dist/index.js';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { platform, arch, cpus } from 'node:os';

const setting = (name, fallback, lo, hi) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < lo || value > hi) throw new Error(`${name} must be ${lo}..${hi}`);
  return value;
};
const count = setting('ENERGY_CASES', 1000, 1, 10000);
const seed = setting('ENERGY_SEED', 90001, 0, 0xffffffff);
const exactRepeats = setting('ENERGY_REPEATS', 32, 1, 256);
const rng = random(seed);
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;

// Exhaustively visit all feasible permutations. No learned cost, library
// evaluator, assignment validator or matching algorithm is shared with assign.
function enumerate(problem) {
  let state = null, cost = Infinity;
  const used = new Set(), partial = [];
  function visit(task, sum) {
    if (task === problem.costs.length) {
      if (sum < cost && (problem.budget === undefined || sum <= problem.budget)) {
        state = partial.slice(); cost = sum;
      }
      return;
    }
    for (let agent = 0; agent < problem.costs[task].length; agent++) {
      const next = problem.costs[task][agent];
      if (next === null || used.has(agent)) continue;
      used.add(agent); partial.push(agent); visit(task + 1, sum + next);
      partial.pop(); used.delete(agent);
    }
  }
  visit(0, 0); return { state, cost };
}

function inspect(problem, result) {
  if (!Array.isArray(result.state) || result.state.length !== problem.costs.length) return { valid: false, cost: null };
  let cost = 0; const used = new Set();
  for (let task = 0; task < result.state.length; task++) {
    const agent = result.state[task];
    if (!Number.isSafeInteger(agent) || agent < 0 || agent >= problem.costs[task].length || used.has(agent)) return { valid: false, cost: null };
    const value = problem.costs[task][agent];
    if (value === null || !Number.isFinite(value)) return { valid: false, cost: null };
    used.add(agent); cost += value;
  }
  const scoreMatches = result.score === undefined || (result.score?.energy === cost && result.score?.violations === 0);
  return { valid: Number.isFinite(cost) && scoreMatches && (problem.budget === undefined || cost <= problem.budget), cost };
}

// Preserve the v1 distribution and seed so measured quality is directly
// comparable; these are synthetic fixtures, not new production evidence.
const cases = Array.from({ length: count }, (_, i) => {
  const rows = 3 + i % 4, columns = rows + (i % 3 === 0 ? 0 : 1);
  const problem = { costs: Array.from({ length: rows }, () => Array.from({ length: columns }, () => rng() < 0.15 ? null : Math.floor(rng() * 100))) };
  const unconstrained = enumerate(problem);
  if (unconstrained.state && i % 5 === 0) problem.budget = unconstrained.cost;
  if (unconstrained.state && i % 11 === 0) problem.budget = unconstrained.cost - 1;
  return { problem, optimum: enumerate(problem) };
});

const energyOptions = { strategy: 'energy', seed: 42, maxMoves: 4000, restarts: 8, temperature: 10 };
const methods = {
  exact: { run: p => assign(p, { strategy: 'exact' }), repeats: exactRepeats },
  energy: { run: p => assign(p, energyOptions), repeats: 1 },
  exhaustiveOracle: { run: enumerate, repeats: 1 },
};
const coldMs = {};
for (const [name, method] of Object.entries(methods)) {
  const start = performance.now(); const result = method.run(cases[0].problem);
  coldMs[name] = performance.now() - start;
  if (name === 'exact' && result.method !== 'exact') throw new Error('Rebuild package: exact assignment API not available');
}
for (let i = 0; i < 50; i++) for (const method of Object.values(methods)) method.run(cases[i % count].problem);

const data = Object.fromEntries(Object.keys(methods).map(name => [name, {
  latency: [], feasible: 0, optimal: 0, invalid: 0, missedFeasible: 0,
  falseInfeasible: 0, falseOptimal: 0, certifiedOptimal: 0, gaps: [], operations: [],
}]));
let checksum = 0;
for (let i = 0; i < cases.length; i++) {
  const { problem, optimum } = cases[i], names = Object.keys(methods);
  // Rotate which implementation runs first. Exact calls are repeated inside
  // one timer to reduce timer quantization and JS call overhead distortion.
  const order = [...names.slice(i % names.length), ...names.slice(0, i % names.length)];
  for (const name of order) {
    const method = methods[name], d = data[name]; let result;
    const start = performance.now();
    for (let repeat = 0; repeat < method.repeats; repeat++) {
      result = method.run(problem);
      const observedCost = result.score?.energy ?? result.cost;
      checksum = (checksum + (Number.isFinite(observedCost) ? observedCost : result.state?.length ?? 0)) % 1000000007;
    }
    d.latency.push((performance.now() - start) / method.repeats);
    if (Number.isFinite(result.operations)) d.operations.push(result.operations);
    if (result.state) {
      d.feasible++;
      const checked = inspect(problem, result);
      if (!checked.valid || !optimum.state) d.invalid++;
      if (checked.cost === optimum.cost) d.optimal++;
      if (result.optimal === true) d.certifiedOptimal++;
      if (result.optimal === true && checked.cost !== optimum.cost) d.falseOptimal++;
      if (optimum.state && checked.cost !== null) d.gaps.push((checked.cost - optimum.cost) / Math.max(1, Math.abs(optimum.cost)));
    } else if (optimum.state) {
      d.missedFeasible++;
      if (result.status === 'infeasible') d.falseInfeasible++;
    }
  }
}

// Larger fixtures have known optima rather than an exponential oracle. A
// unique cheap injective mapping is preserved under column permutations and
// additive row offsets. Each alternative is individually more expensive.
const large = [];
for (const [rows, columns] of [[32, 48], [64, 64]]) {
  const costs = Array.from({ length: rows }, (_, i) => Array.from({ length: columns }, (_, j) =>
    j === (i + 17) % columns ? -10 - i % 5 : rng() < 0.15 ? null : 100 + Math.floor(rng() * 400)));
  const optimum = Array.from({ length: rows }, (_, i) => -10 - i % 5).reduce((a, b) => a + b, 0);
  large.push({ name: `${rows}x${columns} planted`, problem: { costs, budget: optimum }, optimum });
  const permuted = costs.map(row => [...row.slice(1), row[0]]);
  large.push({ name: `${rows}x${columns} column permutation`, problem: { costs: permuted, budget: optimum }, optimum });
  const shifted = costs.map((row, i) => row.map(c => c === null ? null : c + i % 7 - 3));
  const shiftedOptimum = optimum + Array.from({ length: rows }, (_, i) => i % 7 - 3).reduce((a, b) => a + b, 0);
  large.push({ name: `${rows}x${columns} row offsets`, problem: { costs: shifted, budget: shiftedOptimum }, optimum: shiftedOptimum });
}
large.push({ name: 'Hall deficient 32x48', problem: { costs: Array.from({ length: 32 }, (_, i) => Array.from({ length: 48 }, (_, j) => i < 8 && j >= 7 ? null : 1)) }, optimum: null });
large.push({ name: 'more tasks than agents 64x32', problem: { costs: Array.from({ length: 64 }, () => Array(32).fill(1)) }, optimum: null });

const largeResults = large.map(({ name, problem, optimum }) => {
  let result; const start = performance.now();
  for (let repeat = 0; repeat < exactRepeats; repeat++) result = assign(problem, { strategy: 'exact' });
  const meanMs = (performance.now() - start) / exactRepeats;
  const checked = result.state ? inspect(problem, result) : { valid: false, cost: null };
  const correct = optimum === null ? result.state === null && result.status === 'infeasible' : checked.valid && checked.cost === optimum && result.optimal === true;
  return { name, expectedOptimum: optimum, returnedCost: checked.cost, status: result.status,
    certifiedOptimal: result.optimal, operations: result.operations, amortizedMs: meanMs, correct };
});

const summary = Object.fromEntries(Object.entries(data).map(([name, d]) => [name, {
  feasible: d.feasible, optimal: d.optimal, invalid: d.invalid, missedFeasible: d.missedFeasible,
  falseInfeasible: d.falseInfeasible, falseOptimal: d.falseOptimal, certifiedOptimal: d.certifiedOptimal,
  meanGap: mean(d.gaps), p95Gap: percentile(d.gaps, 0.95),
  meanMs: mean(d.latency), p50Ms: percentile(d.latency, 0.5), p95Ms: percentile(d.latency, 0.95),
  meanOperations: mean(d.operations), maxOperations: d.operations.length ? Math.max(...d.operations) : null,
}]));
const feasibleCases = cases.filter(c => c.optimum.state).length;
const report = {
  schemaVersion: 2, workload: 'synthetic injective task assignment; 3..6 tasks, 15% denied pairs, mixed budgets',
  count, seed, options: energyOptions, feasibleCases, coldMs,
  timing: { warmupCallsPerMethod: 50, repeatsPerFixture: Object.fromEntries(Object.entries(methods).map(([n, m]) => [n, m.repeats])),
    interpretation: 'per-fixture amortized warm CPU duration; rotated method order; not request latency or SLA' },
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  summary,
  measuredSpeedups: {
    exactVersusPriorEnergyMean: summary.energy.meanMs / summary.exact.meanMs,
    exactVersusPriorEnergyP95: summary.energy.p95Ms / summary.exact.p95Ms,
    exactVersusExhaustiveMean: summary.exhaustiveOracle.meanMs / summary.exact.meanMs,
  },
  largeResults,
  gates: {
    zeroInvalid: Object.values(summary).every(d => d.invalid === 0),
    exactRecoversEveryFeasibleOptimum: summary.exact.optimal === feasibleCases && summary.exact.missedFeasible === 0,
    exactHasNoFalseCertificates: summary.exact.falseOptimal === 0 && summary.exact.falseInfeasible === 0,
    exactCertifiesEveryReturnedOptimum: summary.exact.certifiedOptimal === feasibleCases,
    largeFixturesAndMetamorphicsPass: largeResults.every(r => r.correct),
  },
  checksum,
  limitations: [
    'Synthetic fixtures only; no production replay, LLM or token-cost comparison',
    'Same small fixture distribution and seed as v1, not a newly independent evaluation set',
    'Repeated exact timings amortize measurement overhead and warm caches; not direct service p95 comparisons',
    'Exhaustive enumeration is an independent correctness oracle, not a competitive matching implementation',
    'Large optima are planted and metamorphic, not an arbitrary large matching oracle',
    'Default assignment now selects a classical exact matching algorithm; these are not CRAM speedups',
  ],
};
console.log(JSON.stringify(report, null, 2));
if (process.env.ENERGY_REPORT) writeFileSync(process.env.ENERGY_REPORT, JSON.stringify(report, null, 2) + '\n');
if (Object.values(report.gates).some(ok => !ok)) process.exitCode = 1;
