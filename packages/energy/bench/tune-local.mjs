// SPDX-License-Identifier: MIT
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { searchEnergy } from '../dist/index.js';
import { createLedger } from './darwin-ledger.mjs';
import { createProposer } from './tpe-proposer.mjs';
import { loadReplay, scoreState, syntheticCases } from './tuning-cases.mjs';

const cpuMs = start => {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
};
const budgetMs = Number(process.env.ENERGY_TUNE_CPU_MS ?? 1000);
if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError('Expected positive ENERGY_TUNE_CPU_MS');
const grid = { moves: [250, 500, 1000, 2000, 4000, 8000], restarts: [1, 2, 4, 8, 16] };
const splits = syntheticCases();
const defaults = { moves: 4000, restarts: 8 };
const seeds = [101, 103, 107, 109, 113];
const maxTrials = 12;
const mean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const p95 = xs => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];

function evaluate(row, config, seed) {
  const start = process.cpuUsage();
  const time = performance.now();
  const result = searchEnergy(row.model, { seed, maxMoves: config.moves, restarts: config.restarts });
  const wallMs = performance.now() - time;
  const consumed = cpuMs(start);
  if (result.method !== 'local' || result.optimal) throw new Error('Expected heuristic local route: ' + row.id);
  if (result.state === null) {
    if (result.status !== 'budget_exhausted' || result.score !== null) throw new Error('Inconsistent cutoff');
    return { id: row.id, energy: null, gap: null, cpuMs: consumed, wallMs };
  }
  const energy = scoreState(row.model, result.state);
  if (result.status !== 'valid' || !Number.isFinite(energy) ||
      result.score?.violations !== 0 || energy !== result.score.energy) throw new Error('Invalid result: ' + row.id);
  const gap = (energy - row.referenceEnergy) / Math.max(1, Math.abs(row.referenceEnergy));
  return { id: row.id, energy, gap, cpuMs: consumed, wallMs };
}

// Missing feasible states disqualify a configuration. CPU used by an unfinished
// trial is recorded, but no observation from outside the cap can select a winner.
function tune(method, seed) {
  const start = process.cpuUsage();
  const proposer = createProposer({ method, seed, ...grid });
  const ledger = createLedger();
  const trials = [];
  let winner = null;
  while (trials.length < maxTrials && cpuMs(start) < budgetMs) {
    const config = proposer.suggest();
    if (!config) break;
    const gaps = [];
    for (const row of splits.train) {
      if (cpuMs(start) >= budgetMs) break;
      gaps.push(evaluate(row, config, seed).gap);
    }
    if (gaps.length !== splits.train.length || cpuMs(start) > budgetMs) break;
    const misses = gaps.filter(gap => gap === null).length;
    // Bounded monotone transform orders valid gaps below any missing-state penalty.
    const valid = gaps.filter(gap => gap !== null);
    const loss = misses + (valid.length ? mean(valid.map(gap => gap / (1 + gap))) : 0);
    const trial = trials.length;
    proposer.observe(config, loss);
    ledger.append({ config, loss, trial });
    trials.push({ config, loss, misses });
    if (!misses) winner = ledger.best();
  }
  return { selected: winner?.config ?? defaults, fallbackToDefaults: !winner,
    cpuMs: cpuMs(start), trials };
}

function summarize(rows) {
  const valid = rows.filter(row => row.energy !== null);
  return { cases: rows.length, feasible: valid.length,
    meanGapPctAmongFeasible: valid.length ? 100 * mean(valid.map(row => row.gap)) : null,
    meanCpuMs: mean(rows.map(row => row.cpuMs)), p95WallMs: p95(rows.map(row => row.wallMs)) };
}

for (const row of splits.train) evaluate(row, defaults, seeds[0]);
const studies = [];
const replay = process.env.ENERGY_REPLAY ? loadReplay(process.env.ENERGY_REPLAY) : null;
for (const [index, seed] of seeds.entries()) {
  const methods = index % 2 ? ['random', 'tpe'] : ['tpe', 'random'];
  const tuning = Object.fromEntries(methods.map(method => [method, tune(method, seed)]));
  const configs = { defaults, random: tuning.random.selected, tpe: tuning.tpe.selected };
  const evaluation = {};
  for (const [split, cases] of Object.entries({ heldout: splits.heldout, regressions: splits.regressions, replay })) {
    if (!cases) continue;
    const rows = { defaults: [], random: [], tpe: [] };
    const names = Object.keys(rows);
    for (const [i, row] of cases.entries()) {
      for (let j = 0; j < names.length; j++) {
        const method = names[(i + index + j) % names.length];
        rows[method].push(evaluate(row, configs[method], seed));
      }
    }
    evaluation[split] = Object.fromEntries(names.map(method => [method, {
      ...summarize(rows[method]), rows: rows[method] }]));
  }
  studies.push({ seed, tuning, evaluation });
}

function aggregate(split, method) {
  return summarize(studies.flatMap(study => study.evaluation[split][method].rows));
}
const summary = {};
for (const split of ['heldout', 'regressions', ...(replay ? ['replay'] : [])]) {
  summary[split] = Object.fromEntries(['defaults', 'random', 'tpe'].map(method => [method, aggregate(split, method)]));
}
let replayGate = { status: 'pending', reason: 'No measured planner replay provided' };
if (replay) {
  const rows = studies.flatMap(study => study.evaluation.replay.tpe.rows);
  const completeBaseline = replay.every(row => row.baselineCpuMs !== undefined);
  const speedup = completeBaseline ? mean(replay.map(row => row.baselineCpuMs)) / mean(rows.map(row => row.cpuMs)) : null;
  const adaptiveTrials = studies.every(s => s.tuning.tpe.trials.length > 4 && !s.tuning.tpe.fallbackToDefaults);
  const qualityPass = rows.every(row => row.gap !== null && row.gap <= 0.01);
  replayGate = { qualityPass, adaptiveTrials, meanCpuSpeedup: speedup,
    status: !qualityPass ? 'failed' : (!completeBaseline || !adaptiveTrials) ? 'pending' : speedup >= 2 ? 'passed' : 'failed' };
}
const report = { node: process.version, cpu: cpus()[0]?.model, seeds, maxTrials, budgetMs, grid, defaults,
  reference: 'Exact cycle DP for synthetic cases; independently rescored planner incumbent for replay',
  summary, replayGate, studies };
if (process.env.ENERGY_REPORT) writeFileSync(process.env.ENERGY_REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ summary, replayGate, completedTrials: studies.map(s => ({
  seed: s.seed, tpe: s.tuning.tpe.trials.length, random: s.tuning.random.trials.length })) }, null, 2));
