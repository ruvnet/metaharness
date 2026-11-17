// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { assign, evaluate, fit, random, solve, validateAssignment, type EnergyModel } from '../src/index.js';

const model: EnergyModel = {
  unary: [[0, 2], [3, 0], [1, 0]],
  pairs: [{ i: 0, j: 1, costs: [[null, 1], [0, null]] }], fixed: { 2: 1 },
};
describe('energy search', () => {
  it('evaluates unary, pair masks and clamps independently', () => {
    expect(evaluate(model, [0, 1, 1])).toEqual({ energy: 1, violations: 0 });
    expect(evaluate(model, [0, 0, 0])).toEqual({ energy: 4, violations: 2 });
  });
  it('preserves clamped values and finds the feasible optimum', () => {
    const r = solve(model, { seed: 11, maxMoves: 300 });
    expect(r.state).toEqual([0, 1, 1]); expect(r.optimal).toBe(false);
    expect(r.score).toEqual(evaluate(model, r.state!));
  });
  it('does not call budget exhaustion a proof of infeasibility', () => {
    const r = solve({ unary: [[null]] });
    expect(r).toMatchObject({ state: null, score: null, status: 'budget_exhausted', optimal: false });
  });
  it('honors a zero move budget and immutable inputs', () => {
    const before = JSON.stringify(model);
    expect(solve(model, { initial: [0, 1, 0], maxMoves: 0 }).moves).toBe(0);
    expect(JSON.stringify(model)).toBe(before);
  });
  it('handles a fully clamped model', () => {
    expect(solve({ unary: [[0]], fixed: { 0: 0 } }).state).toEqual([0]);
  });
  it('sparse deltas match full recomputation over random graphs and swaps', () => {
    const rng = random(984);
    for (let seed = 0; seed < 100; seed++) {
      const n = 2 + seed % 6, c = 2 + seed % 3;
      const costs = () => rng() < 0.1 ? null : Math.floor(rng() * 20) - 10;
      const m: EnergyModel = { unary: Array.from({ length: n }, () => Array.from({ length: c }, costs)), pairs: [] };
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rng() < 0.4) {
        m.pairs!.push({ i, j, costs: Array.from({ length: c }, () => Array.from({ length: c }, costs)) });
      }
      const options = { seed, maxMoves: 500, restarts: 4 };
      expect(solve(m, { ...options, incremental: true })).toEqual(solve(m, { ...options, incremental: false }));
    }
  });
  it('supports different domain sizes', () => {
    const m = { unary: [[1], [3, 2], [5, 4, -1]] };
    expect(solve(m, { maxMoves: 300 }).state).toEqual([0, 1, 2]);
  });
  it('automatically selects the equivalent sparse path on larger sparse graphs', () => {
    const m = {
      unary: Array.from({ length: 20 }, (_, i) => [i % 3, 2]),
      pairs: Array.from({ length: 19 }, (_, i) => ({ i, j: i + 1, costs: [[2, 0], [0, 2]] })),
    };
    const options = { seed: 19, maxMoves: 1000 };
    expect(solve(m, options)).toEqual(solve(m, { ...options, incremental: true }));
    expect(solve(m, options)).toEqual(solve(m, { ...options, incremental: false }));
  });
  it('validates fractional costs with full recomputation before returning', () => {
    const m = { unary: [[0.1, 0.2], [0.3, 0.4]], pairs: [{ i: 0, j: 1, costs: [[null, 0.01], [0.02, null]] }] };
    const r = solve(m, { maxMoves: 2000, incremental: true });
    expect(r.state).not.toBeNull(); expect(r.score).toEqual(evaluate(m, r.state!));
  });
  it.each([
    { unary: [] }, { unary: [[NaN]] }, { unary: [[Infinity]] },
    { unary: [[0]], fixed: { 0: 1 } }, { unary: [[null]], fixed: { 0: 0 } },
    { unary: [[0], [0]], pairs: [{ i: 1, j: 0, costs: [[0]] }] },
    { unary: [[0], [0]], pairs: [{ i: 0, j: 1, costs: [[0, 0]] }] },
    { unary: [[0], [0]], pairs: [{ i: 0, j: 1, costs: [[0]] }, { i: 0, j: 1, costs: [[0]] }] },
    { unary: [new Array(2)] },
  ])('rejects malformed or nonfinite models: %j', m => expect(() => solve(m)).toThrow());
  it('rejects invalid budgets, seeds, states and temperatures', () => {
    for (const o of [{ maxMoves: -1 }, { maxMoves: Infinity }, { restarts: 0 }, { seed: -1 }, { temperature: -1 }, { initial: [9] }]) {
      expect(() => solve({ unary: [[0]] }, o)).toThrow();
    }
    expect(() => evaluate({ unary: [[0]] }, new Array(1))).toThrow();
    expect(() => evaluate(model, [0])).toThrow();
  });
});

describe('assignment adapter', () => {
  it('crosses single-variable barriers with swaps', () => {
    const p = { costs: [[1, 2], [1, 99]] };
    const r = assign(p, { maxMoves: 1000, seed: 7 });
    expect(r.state).toEqual([1, 0]); expect(r.score?.energy).toBe(3);
  });
  it('rejects over-budget, duplicated, unauthorized and malformed candidates', () => {
    const p = { costs: [[0, null], [0, 5]], budget: 4 };
    for (const state of [[0, 1], [0, 0], [1, 0], [0, -1], [0, NaN], [0]]) {
      expect(validateAssignment(p, state)).toBe(false);
    }
    expect(assign(p).state).toBeNull();
  });
  it('includes exact budget equality and supports negative preference costs', () => {
    const p = { costs: [[-4, 8], [9, 1]], budget: -3 };
    const r = assign(p); expect(r.state).toEqual([0, 1]); expect(validateAssignment(p, r.state!)).toBe(true);
  });
  it('never returns invalid assignments across random restrictive masks', () => {
    const rng = random(732);
    for (let trial = 0; trial < 100; trial++) {
      const p = { costs: Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => rng() < 0.3 ? null : Math.floor(rng() * 100))), budget: 100 };
      const r = assign(p, { seed: trial, maxMoves: 1000 });
      if (r.state) expect(validateAssignment(p, r.state)).toBe(true);
    }
  });
  it('bounds allocation before expanding assignment constraints', () => {
    expect(() => assign({ costs: Array.from({ length: 100 }, () => Array(64).fill(0)) })).toThrow('entry budget');
    expect(() => assign({ costs: [[0], [0, 1]] })).toThrow('rectangular');
    expect(() => assign({ costs: [[0]], budget: NaN })).toThrow();
  });
});

describe('local pseudolikelihood learning', () => {
  it('learns a known pair association and completes clamped partial inputs', () => {
    const m = { unary: [[0, 0], [0, 0]], pairs: [{ i: 0, j: 1, costs: [[0, 0], [0, 0]] }] };
    const before = JSON.stringify(m);
    const f = fit(m, [[0, 0], [1, 1]], { epochs: 100 });
    expect(f.finalLoss).toBeLessThan(f.initialLoss / 4);
    expect(JSON.stringify(m)).toBe(before);
    expect(f.model.pairs![0].costs[0][0]!).toBeLessThan(f.model.pairs![0].costs[0][1]!);
    for (const clue of [0, 1]) {
      const r = solve({ ...f.model, fixed: { 0: clue } }, { seed: clue, temperature: 0, maxMoves: 200 });
      expect(r.state).toEqual([clue, clue]);
    }
  });
  it('keeps hard masks immutable and rejects unfeasible labels', () => {
    const m = { unary: [[0, null], [0, 0]], pairs: [{ i: 0, j: 1, costs: [[0, null], [0, 0]] }] };
    const f = fit(m, [[0, 0]]);
    expect(f.model.unary[0][1]).toBeNull(); expect(f.model.pairs![0].costs[0][1]).toBeNull();
    expect(() => fit(m, [[0, 1]])).toThrow('infeasible');
  });
  it('rejects invalid training options and bounds work', () => {
    expect(() => fit(model, [])).toThrow();
    expect(() => fit(model, [[0, 1, 1]], { learningRate: -1 })).toThrow();
    expect(() => fit(model, [[0, 1, 1]], { epochs: Infinity })).toThrow();
    expect(() => fit({ unary: Array.from({ length: 64 }, () => Array(64).fill(0)) },
      Array.from({ length: 1000 }, () => Array(64).fill(0)), { epochs: 1000 })).toThrow('work budget');
  });
});
