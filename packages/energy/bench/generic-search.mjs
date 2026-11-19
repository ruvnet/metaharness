// SPDX-License-Identifier: MIT
// Run after building @metaharness/energy. ENERGY_REPORT optionally saves JSON.
import { searchEnergy, solve } from '../dist/index.js';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform } from 'node:os';
import { writeFileSync } from 'node:fs';

const count = 320, seed = 819137, repeats = 3, warmup = 24;
const stochastic = { seed: 41, restarts: 4, maxMoves: 750, temperature: 3 };
const local = { ...stochastic, strategy: 'local' };
const auto = { strategy: 'auto', maxOperations: 1_000_000 };
let rngState = seed;
function draw(max) {
  // Upper bits avoid the short period of a modulo reduction of low LCG bits.
  rngState = (Math.imul(1664525, rngState) + 1013904223) >>> 0;
  return Math.floor((rngState / 4294967296) * max);
}
const row = length => Array.from({ length }, () => draw(8) === 0 ? null : draw(23) - 11);
function fixture(index) {
  const n = 3 + draw(5), cyclic = index % 2 === 1;
  const unary = Array.from({ length: n }, () => row(2 + draw(3)));
  const pairs = [], fixed = {};
  function add(i, j) {
    pairs.push({ i, j, costs: unary[i].map(() => row(unary[j].length)) });
  }
  for (let j = 1; j < n; j++) {
    if (cyclic && j < 3) add(j - 1, j);
    else if (cyclic || draw(4) > 0) add(draw(j), j);
  }
  if (cyclic) add(0, 2);
  for (let i = 0; i < n; i++) {
    const a = draw(unary[i].length);
    if (draw(5) === 0 && unary[i][a] !== null) fixed[i] = a;
  }
  // Known infeasibility within each stratum supplements random contradictions.
  if (index % 26 < 2) {
    unary[n - 1].fill(null);
    delete fixed[n - 1];
  }
  return { type: cyclic ? 'cycle' : 'forest', model: { unary, pairs, fixed } };
}

// Full-state evaluator shared only by the independent oracle and the benchmark.
// Infinity represents a hard violation. No search or scoring code is imported.
function score(model, state) {
  if (!Array.isArray(state) || state.length !== model.unary.length) return Infinity;
  let total = 0;
  for (let i = 0; i < state.length; i++) {
    const a = state[i], cost = model.unary[i][a];
    if (!Number.isInteger(a) || !Number.isFinite(cost)) return Infinity;
    if (model.fixed[i] !== undefined && a !== model.fixed[i]) return Infinity;
    total += cost;
  }
  for (const { i, j, costs } of model.pairs) {
    const cost = costs[state[i]][state[j]];
    if (cost === null) return Infinity;
    total += cost;
  }
  return total;
}

// Enumerate every complete state, including hard violations. This visits the
// whole Cartesian product independently of the solver's pruning or topology.
function oracle(model) {
  const state = Array(model.unary.length).fill(0);
  let best = Infinity;
  for (;;) {
    best = Math.min(best, score(model, state));
    let i = 0;
    while (i < state.length && ++state[i] === model.unary[i].length) state[i++] = 0;
    if (i === state.length) return best;
  }
}
const fixtures = Array.from({ length: count }, (_, i) => fixture(i));
for (const f of fixtures) f.optimum = oracle(f.model);

const methods = {
  auto: model => searchEnergy(model, auto),
  local: model => searchEnergy(model, local),
  legacy: model => {
    const result = solve(model, stochastic);
    return { ...result, method: 'legacy', operations: result.moves };
  },
};
function counters() {
  return { cases: 0, feasible: 0, validStates: 0, optimalStates: 0, infeasibleProven: 0,
    invalidOutputs: 0, exactMismatches: 0, routeErrors: 0, latency: [], operations: [] };
}
const results = {};
for (const type of ['forest', 'cycle']) {
  results[type] = Object.fromEntries(Object.keys(methods).map(name => [name, counters()]));
}
for (const run of Object.values(methods)) {
  for (const f of fixtures.slice(0, warmup)) run(f.model);
}
const pairedLocal = { improved: 0, same: 0, worse: 0 };
for (const [i, f] of fixtures.entries()) {
  // Rotate the first measured method within each stratum.
  const names = Object.keys(methods), offset = (i >> 1) % names.length;
  const order = names.slice(offset).concat(names.slice(0, offset));
  const costs = {};
  for (const name of order) {
    const b = results[f.type][name];
    const start = performance.now();
    let out;
    for (let k = 0; k < repeats; k++) out = methods[name](f.model);
    b.latency.push((performance.now() - start) / repeats);
    b.operations.push(out.operations);
    b.cases++;
    const feasible = Number.isFinite(f.optimum);
    if (feasible) b.feasible++;
    const value = score(f.model, out.state);
    costs[name] = value;
    const present = out.state !== null;
    const valid = present && Number.isFinite(value) && out.score?.violations === 0 && out.score.energy === value;
    if (valid) b.validStates++;
    if (valid && value === f.optimum) b.optimalStates++;
    if (!feasible && out.status === 'infeasible') b.infeasibleProven++;
    if ((present && !valid) || (!present && out.score !== null) ||
        (out.status === 'valid' && !valid) || (out.status === 'infeasible' && (present || feasible))) b.invalidOutputs++;
    if (name === 'auto') {
      if (feasible ? (!valid || value !== f.optimum || !out.optimal || out.status !== 'valid') :
        (out.status !== 'infeasible' || present || out.optimal)) b.exactMismatches++;
    }
    const expected = name === 'auto' ? (f.type === 'forest' ? 'forest' : 'enumerate') : name;
    if (out.method !== expected || (name !== 'auto' && out.optimal)) b.routeErrors++;
  }
  if (costs.local < costs.legacy) pairedLocal.improved++;
  else if (costs.local > costs.legacy) pairedLocal.worse++;
  else pairedLocal.same++;
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const stratum of Object.values(results)) for (const b of Object.values(stratum)) {
  b.meanMs = mean(b.latency);
  b.p95Ms = b.latency.sort((a, c) => a - c)[Math.ceil(0.95 * b.cases) - 1];
  b.meanOperations = mean(b.operations);
  delete b.latency;
  delete b.operations;
}

// The root clamp and edge parity uniquely determine all 511 variables.
const n = 511, planted = [1];
const tree = { unary: Array.from({ length: n }, (_, i) => [-5 + i % 9, 3 - i % 7]), fixed: { 0: 1 }, pairs: [] };
for (let j = 1; j < n; j++) {
  const i = (j - 1) >> 1, parity = j % 2;
  planted.push(planted[i] ^ parity);
  tree.pairs.push({ i, j, costs: parity ? [[null, -1], [2, null]] : [[-2, null], [null, 3]] });
}
const branch = searchEnergy(tree, auto);
const treeExpected = score(tree, planted);

// All 96 binary ring variables can be set to zero at the joint lower bound.
// All proposals are feasible, so the fallback can be checked without an oracle.
const ring = { unary: Array.from({ length: 96 }, () => [0, 1]), fixed: {}, pairs: [] };
for (let j = 1; j < 96; j++) ring.pairs.push({ i: j - 1, j, costs: [[0, 2], [2, 0]] });
ring.pairs.push({ i: 0, j: 95, costs: [[0, 2], [2, 0]] });
// On the frustrated ring a state with k ones has at least
// 96 - 2 * min(k, 96-k) equal edges. Thus cost >= 48, attained by alternation.
const frustrated = { ...ring, pairs: ring.pairs.map(pair => ({ ...pair, costs: [[3, 0], [0, 3]] })) };
function compareFallback(model, optimum) {
  const legacy = methods.legacy(model);
  const current = searchEnergy(model, { ...stochastic, strategy: 'auto' });
  const checked = out => out.status === 'valid' && !out.optimal && out.moves <= stochastic.maxMoves &&
    out.score?.violations === 0 && out.score.energy === score(model, out.state) && out.score.energy >= optimum;
  return { variables: model.unary.length, optimum, legacy: legacy.score?.energy, current: current.score?.energy,
    gap: current.score?.energy - optimum, method: current.method, moves: current.moves,
    checked: checked(legacy) && checked(current) && current.method === 'local' && current.score.energy <= legacy.score.energy };
}
const smoothRing = compareFallback(ring, 0);
const frustratedRing = compareFallback(frustrated, 48);
const capped = searchEnergy(ring, { strategy: 'enumerate', maxOperations: 0, initial: Array(96).fill(1) });

const buckets = Object.values(results).flatMap(Object.values);
const report = {
  seed, count, variablesPerFixture: '3..7', domainSizes: '2..4',
  strategies: { auto, local, legacy: { entrypoint: 'solve', ...stochastic } },
  timing: { warmupPerMethod: warmup, repeatsPerMethodAndFixture: repeats,
    description: 'Mean and p95 of warm per-fixture amortized CPU wall times in ms. Synthetic single-process measurements.' },
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  operationUnits: 'Forest DP candidate inspections, enumeration candidate and incident factor inspections, and stochastic moves measure different work.',
  results, pairedLocalVersusLegacy: pairedLocal,
  largeForest: { variables: n, expected: treeExpected, returned: branch.score?.energy, method: branch.method, operations: branch.operations },
  largeCycles: { smoothRing, frustratedRing },
  zeroBudget: { status: capped.status, operations: capped.operations, returned: capped.score?.energy },
  gates: {
    independentlyValidResults: buckets.every(b => b.invalidOutputs === 0),
    exactOutcomesMatchOracle: buckets.every(b => b.exactMismatches === 0),
    correctRoutingAndClaims: buckets.every(b => b.routeErrors === 0),
    plantedTreeRecovered: branch.method === 'forest' && branch.status === 'valid' && branch.optimal &&
      branch.score?.violations === 0 && branch.score.energy === treeExpected && score(tree, branch.state) === treeExpected,
    explicitLocalNeverRegresses: pairedLocal.worse === 0,
    largeCyclesUseBoundedLocalSearch: smoothRing.checked && frustratedRing.checked,
    smoothRingRecoversKnownOptimum: smoothRing.current === smoothRing.optimum,
    interruptedIncumbentRetained: capped.method === 'enumerate' && capped.status === 'budget_exhausted' && !capped.optimal &&
      capped.operations === 0 && capped.score?.violations === 0 && capped.score.energy === 96 && score(ring, capped.state) === 96,
  },
};
const json = JSON.stringify(report, null, 2) + '\n';
if (process.env.ENERGY_REPORT) writeFileSync(process.env.ENERGY_REPORT, json);
process.stdout.write(json);
if (Object.values(report.gates).some(pass => !pass)) process.exitCode = 1;
