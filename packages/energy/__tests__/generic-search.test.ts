// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { searchEnergy, solve, type Cost, type EnergyModel, type Pair } from '../src/index.js';

// Raw table scorer and mixed-radix counter intentionally share no production
// feasibility checks, variable ordering, bounds, or random-number generator.
function directCost(model: EnergyModel, state: number[]): number {
  if (state.length !== model.unary.length) return Infinity;
  let energy = 0;
  for (let i = 0; i < state.length; i++) {
    const value = state[i];
    if (!Number.isInteger(value) || value < 0 || value >= model.unary[i].length) return Infinity;
    if (model.fixed?.[i] !== undefined && model.fixed[i] !== value) return Infinity;
    const cost = model.unary[i][value];
    if (cost === null) return Infinity;
    energy += cost;
  }
  for (const { i, j, costs } of model.pairs ?? []) {
    const cost = costs[state[i]][state[j]];
    if (cost === null) return Infinity;
    energy += cost;
  }
  return energy;
}

function exhaustiveMinimum(model: EnergyModel): number {
  const state: number[] = model.unary.map(() => 0);
  let best = Infinity;
  for (;;) {
    best = Math.min(best, directCost(model, state));
    let i = 0;
    while (i < state.length && ++state[i] === model.unary[i].length) state[i++] = 0;
    if (i === state.length) return best;
  }
}

function fixture(seed: number, cyclic: boolean): EnergyModel {
  let bits = seed;
  const random = () => {
    bits ^= bits << 13; bits ^= bits >>> 17; bits ^= bits << 5;
    return (bits >>> 0) / 2 ** 32;
  };
  const integer = (n: number) => Math.floor(random() * n);
  const cost = (): Cost => random() < 0.2 ? null : integer(37) - 18;
  const n = 3 + seed % 4;
  const unary = Array.from({ length: n }, () => Array.from({ length: 1 + integer(3) }, cost));
  const fixed: Record<number, number> = {};
  for (let i = 0; i < n; i++) {
    const v = integer(unary[i].length);
    if (unary[i][v] !== null && random() < 0.22) fixed[i] = v;
  }
  // Renumber vertices so that child and parent can appear on either table axis.
  const order = unary.map((_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = integer(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const pairs: Pair[] = [];
  const edge = (a: number, b: number) => {
    const i = Math.min(order[a], order[b]), j = Math.max(order[a], order[b]);
    pairs.push({ i, j, costs: unary[i].map(() => unary[j].map(cost)) });
  };
  if (cyclic) { edge(0, 1); edge(1, 2); edge(0, 2); }
  for (let v = cyclic ? 3 : 1; v < n; v++) {
    if (random() < 0.78) edge(v, integer(v));
  }
  return { unary, pairs, fixed };
}

const inequality = [[null, 0], [0, null]];
const oddCycle: EnergyModel = {
  unary: [[0, 0], [0, 0], [0, 0]],
  pairs: [{ i: 0, j: 1, costs: inequality }, { i: 1, j: 2, costs: inequality },
    { i: 0, j: 2, costs: inequality }],
};

describe('searchEnergy', () => {
  it.each([false, true])('matches exhaustive objectives, masks and clamps for 160 models (cyclic=%s)', cyclic => {
    let feasible = 0;
    for (let sample = 0; sample < 160; sample++) {
      const seed = Math.imul(sample + 781, 0x9e3779b1) >>> 0;
      const model = fixture(seed, cyclic);
      const before = JSON.stringify(model);
      const expected = exhaustiveMinimum(model);
      const result = searchEnergy(model);
      expect(result.method, String(seed)).toBe(cyclic ? 'enumerate' : 'forest');
      if (Number.isFinite(expected)) {
        feasible++;
        expect(result, String(seed)).toMatchObject({
          status: 'valid', optimal: true, moves: 0, score: { violations: 0, energy: expected },
        });
        expect(directCost(model, result.state!), String(seed)).toBe(expected);
      } else {
        expect(result, String(seed)).toMatchObject({ status: 'infeasible', state: null, score: null });
      }
      expect(JSON.stringify(model)).toBe(before);
    }
    expect(feasible).toBeGreaterThan(0);
    expect(feasible).toBeLessThan(160);
  });

  it('distinguishes pairwise inconsistency around an odd cycle from a search cutoff', () => {
    expect(searchEnergy(oddCycle)).toMatchObject({ method: 'enumerate', status: 'infeasible', state: null });
    expect(searchEnergy(oddCycle, { maxOperations: 0 })).toMatchObject({
      status: 'budget_exhausted', state: null, score: null, operations: 0, optimal: false,
    });
    expect(() => searchEnergy(oddCycle, { strategy: 'forest' })).toThrow();
  });

  it('handles an impossible forest component without returning a partial solution', () => {
    const model = { unary: [[-2], [0, 0], [0, 0]], pairs: [{ i: 1, j: 2, costs: inequality }],
      fixed: { 1: 0, 2: 0 } };
    expect(searchEnergy(model)).toMatchObject({ method: 'forest', status: 'infeasible', state: null, score: null });
    expect(searchEnergy({ unary: [[-1], [null, null]] })).toMatchObject({ status: 'infeasible', state: null });
  });

  it('enforces exact budgets up to the operation that completes a proof', () => {
    const model: EnergyModel = { unary: [[1, -2], [2, 3]], pairs: [{ i: 0, j: 1, costs: inequality }] };
    for (const strategy of ['forest', 'enumerate'] as const) {
      const complete = searchEnergy(model, { strategy });
      expect(complete.operations).toBeGreaterThan(0);
      expect(searchEnergy(model, { strategy, maxOperations: complete.operations })).toEqual(complete);
      for (let cap = 0; cap < complete.operations; cap++) {
        const limited = searchEnergy(model, { strategy, maxOperations: cap });
        expect(limited).toMatchObject({ status: 'budget_exhausted', optimal: false });
        expect(limited.operations).toBeLessThanOrEqual(cap);
        if (limited.state) expect(limited.score).toEqual({ violations: 0, energy: directCost(model, limited.state) });
        else expect(limited.score).toBeNull();
      }
    }
  });

  it('preserves a feasible incumbent and discards an infeasible one at the enumeration cutoff', () => {
    const model = { unary: [[0, -2], [0, -3]], pairs: [{ i: 0, j: 1, costs: inequality }] };
    const options = { strategy: 'enumerate' as const, maxOperations: 0 };
    const initial = [1, 0];
    const result = searchEnergy(model, { ...options, initial });
    expect(result).toMatchObject({ state: [1, 0], score: { energy: -2, violations: 0 },
      optimal: false, status: 'budget_exhausted' });
    initial[0] = 0;
    expect(result.state).toEqual([1, 0]);
    expect(searchEnergy(model, { ...options, initial })).toMatchObject({ state: null, score: null });
    expect(searchEnergy({ ...model, fixed: { 0: 1 } }, { ...options, initial: [0, 1] }).state).toBeNull();
  });

  it('preserves only a validated forest incumbent when its operation budget runs out', () => {
    const model = { unary: [[2, 0], [0, -1]], pairs: [{ i: 0, j: 1, costs: inequality }], fixed: { 0: 1 } };
    for (const maxOperations of [0, 1]) {
      const options = { strategy: 'forest' as const, maxOperations };
      expect(searchEnergy(model, { ...options, initial: [1, 0] })).toMatchObject({
        state: [1, 0], score: { energy: 0, violations: 0 }, status: 'budget_exhausted', optimal: false,
      });
      for (const initial of [[1, 1], [0, 1]]) {
        expect(searchEnergy(model, { ...options, initial })).toMatchObject({
          state: null, score: null, status: 'budget_exhausted', optimal: false,
        });
      }
    }
  });

  it('handles wide signed sums and late negative pair preferences in both exact strategies', () => {
    const model = { unary: [[0, 10], [1e9], [-1e9], [-1e9]], pairs: [
      { i: 0, j: 1, costs: [[1e9], [-1e9]] }, { i: 2, j: 3, costs: [[-1e9]] }] };
    for (const strategy of ['forest', 'enumerate'] as const) {
      expect(searchEnergy(model, { strategy })).toMatchObject({ optimal: true,
        state: [1, 0, 0, 0], score: { violations: 0, energy: -3e9 + 10 } });
    }
  });

  it('resolves a maximum length clamped chain with deterministic reconstruction', () => {
    const n = 1024;
    const model = { unary: Array.from({ length: n }, () => [1, 1]),
      pairs: Array.from({ length: n - 1 }, (_, i) => ({ i, j: i + 1, costs: inequality })),
      fixed: { [n - 1]: 1 } };
    const result = searchEnergy(model);
    expect(result).toMatchObject({ method: 'forest', status: 'valid', optimal: true, score: { energy: n, violations: 0 } });
    expect(result.state).toEqual(Array.from({ length: n }, (_, i) => i % 2));
    expect(searchEnergy(model, { seed: 456 })).toEqual(result);
  });

  it('selects seeded local search for a fractional pair factor and a large cyclic model', () => {
    const fractional = { unary: [[0, 0], [0, 0]], pairs: [{ i: 0, j: 1, costs: [[0.25, 0], [0, 0]] }] };
    const n = 36;
    const large = { unary: Array.from({ length: n }, () => [0, 2]),
      pairs: [...Array.from({ length: n - 1 }, (_, i) => ({ i, j: i + 1, costs: [[1, 0], [0, 1]] })),
        { i: 0, j: n - 1, costs: [[1, 0], [0, 1]] }] };
    for (const strategy of ['forest', 'enumerate'] as const) {
      expect(() => searchEnergy(fractional, { strategy })).toThrow();
    }
    for (const model of [fractional, large]) {
      const options = { maxMoves: 37, restarts: 2, seed: 81, initial: model.unary.map(() => 0) };
      const result = searchEnergy(model, options);
      const expected = solve(model, options);
      expect(result).toMatchObject({ ...expected, method: 'local', optimal: false, operations: expected.moves });
      expect(directCost(model, result.state!)).toBe(result.score!.energy);
      expect(searchEnergy(model, { ...options, strategy: 'local' })).toEqual(result);
    }
  });

  it('validates exact budget, strategy, initial shape and input tables at the public entry point', () => {
    const model = { unary: [[1, 0]] };
    for (const maxOperations of [-1, Infinity, NaN, 0.5]) {
      expect(() => searchEnergy(model, { maxOperations })).toThrow();
    }
    expect(() => searchEnergy(model, { strategy: 'other' as 'auto' })).toThrow();
    expect(() => searchEnergy(model, { initial: [2], strategy: 'enumerate' })).toThrow();
    expect(() => searchEnergy({ unary: [[NaN]] })).toThrow();
    expect(() => searchEnergy({ unary: [Array(2)] })).toThrow();
  });

  it('limits local moves by the smaller of the move and operation budgets', () => {
    const model = { unary: [[2, -1], [0, 3]] };
    for (const [maxMoves, maxOperations] of [[9, 3], [3, 9], [0, 9], [9, 0]]) {
      const result = searchEnergy(model, { strategy: 'local', initial: [0, 0], seed: 73, maxMoves, maxOperations });
      expect(result).toMatchObject({ method: 'local', optimal: false,
        moves: Math.min(maxMoves, maxOperations), operations: Math.min(maxMoves, maxOperations) });
      expect(result.score).toEqual({ violations: 0, energy: directCost(model, result.state!) });
    }
  });

  it('detects the empty final domain of a cyclic graph after its domain product crosses the exact threshold', () => {
    const unary: Cost[][] = Array.from({ length: 37 }, () => [0, 1]);
    unary[unary.length - 1] = [null, null];
    const costs = [[0, 1], [1, 0]];
    const model = { unary, pairs: [...Array.from({ length: unary.length - 1 }, (_, i) => ({ i, j: i + 1, costs })),
      { i: 0, j: unary.length - 1, costs }] };
    expect(searchEnergy(model)).toMatchObject({ status: 'infeasible', state: null, score: null, method: 'enumerate' });
  });

  it('reads the local initial option once and avoids unrelated getters', () => {
    let reads = 0;
    const options = {
      strategy: 'local' as const, maxMoves: 0,
      get initial() {
        if (++reads > 1) throw new Error('initial option read twice');
        return [1];
      },
      get unused() { throw new Error('unrelated option accessed'); },
    };
    expect(searchEnergy({ unary: [[0, 1]] }, options)).toMatchObject({ state: [1], moves: 0 });
    expect(reads).toBe(1);
  });

  it('limits random restarts to funded moves', () => {
    const unary = Array.from({ length: 16 }, () => [1, 0]);
    const options = { strategy: 'local' as const, maxMoves: 1, initial: unary.map(() => 0), seed: 3 };
    const one = searchEnergy({ unary }, { ...options, restarts: 1 });
    expect(one.score!.energy).toBeGreaterThanOrEqual(15);
    expect(searchEnergy({ unary }, { ...options, restarts: 1024 })).toEqual(one);
  });

  it('recovers a zero-cost ring using its feasible unary guess with one move', () => {
    const n = 36;
    const unary = Array.from({ length: n }, () => [0, 1]);
    const pairCosts = [[0, 2], [2, 0]];
    const model = { unary, pairs: [...Array.from({ length: n - 1 }, (_, i) => ({ i, j: i + 1, costs: pairCosts })),
      { i: 0, j: n - 1, costs: pairCosts }] };
    const options = { seed: 7, restarts: 1, maxMoves: 1 };
    expect(solve(model, options).score!.energy).toBeGreaterThan(0);
    expect(searchEnergy(model, options)).toMatchObject({ state: unary.map(() => 0), moves: 1,
      method: 'local', status: 'valid', optimal: false, score: { violations: 0, energy: 0 } });
    const zeroMoves = { ...options, maxMoves: 0 };
    expect(searchEnergy(model, zeroMoves)).toMatchObject(solve(model, zeroMoves));
  });

  it('rejects a unary guess that violates a pair mask and retains a feasible stochastic result', () => {
    const model = { unary: [[0, 5], [0, 5]], pairs: [{ i: 0, j: 1, costs: inequality }] };
    const result = searchEnergy(model, { strategy: 'local', maxMoves: 1, seed: 3, restarts: 1 });
    expect(result).toMatchObject({ status: 'valid', optimal: false, score: { violations: 0, energy: 5 } });
    expect(directCost(model, result.state!)).toBe(5);
  });
});
