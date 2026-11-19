// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { assign, verifyAssignmentCertificate, type AssignmentProblem, type Cost } from '../src/index.js';

// Independent exhaustive oracle. No production search, scoring, validation or
// random-number helper is reused, and negative costs are never pruned away.
function oracle(problem: AssignmentProblem): { state: number[] | null; cost: number } {
  let best: number[] | null = null, cost = Infinity;
  const state: number[] = [], used = new Set<number>();
  function visit(task: number, sum: number): void {
    if (task === problem.costs.length) {
      if (sum < cost && (problem.budget === undefined || sum <= problem.budget)) {
        best = [...state]; cost = sum;
      }
      return;
    }
    for (let agent = 0; agent < problem.costs[task].length; agent++) {
      const value = problem.costs[task][agent];
      if (value === null || used.has(agent)) continue;
      used.add(agent); state.push(agent);
      visit(task + 1, sum + value);
      state.pop(); used.delete(agent);
    }
  }
  visit(0, 0); return { state: best, cost };
}

function independentlyCheck(problem: AssignmentProblem, state: number[]): number {
  expect(state.length).toBe(problem.costs.length);
  expect(new Set(state).size).toBe(state.length);
  let cost = 0;
  for (let task = 0; task < state.length; task++) {
    const agent = state[task];
    expect(Number.isSafeInteger(agent)).toBe(true);
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(agent).toBeLessThan(problem.costs[task].length);
    const value = problem.costs[task][agent];
    expect(value).not.toBeNull(); cost += value!;
  }
  if (problem.budget !== undefined) expect(cost).toBeLessThanOrEqual(problem.budget);
  return cost;
}

describe('exact assignment', () => {
  it('matches independent exhaustive enumeration on 400 masked, signed rectangular problems', () => {
    let seed = 713074;
    const next = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    for (let trial = 0; trial < 400; trial++) {
      const tasks = 1 + trial % 5, agents = 1 + Math.floor(next() * 6);
      const costs: Cost[][] = [];
      for (let i = 0; i < tasks; i++) {
        const row: Cost[] = [];
        for (let j = 0; j < agents; j++) row.push(next() < 0.3 ? null : Math.floor(next() * 41) - 20);
        costs.push(row);
      }
      const problem: AssignmentProblem = { costs };
      const unconstrained = oracle(problem);
      // Include equality and impossible budget boundaries on negative totals.
      if (unconstrained.state && trial % 3 === 0) problem.budget = unconstrained.cost + (trial % 2 ? -1 : 0);
      const expected = oracle(problem), before = JSON.stringify(problem);
      const actual = assign(problem);
      expect(JSON.stringify(problem)).toBe(before);
      expect(actual.method).toBe('exact');
      if (expected.state === null) {
        expect(actual.state, `trial ${trial}`).toBeNull();
        expect(actual.status, `trial ${trial}`).toBe('infeasible');
      } else {
        expect(actual.status, `trial ${trial}`).toBe('valid');
        expect(actual.state, `trial ${trial}`).not.toBeNull();
        expect(independentlyCheck(problem, actual.state!)).toBe(expected.cost);
        expect(actual.score).toEqual({ violations: 0, energy: expected.cost });
        expect(actual.optimal).toBe(true);
        expect(actual.certificate).toBeDefined();
        expect(verifyAssignmentCertificate(problem, actual.state!, actual.certificate!)).toBe(true);
      }
      expect(actual.operations).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('detects Hall infeasibility even when every row has an allowed edge', () => {
    const result = assign({ costs: [[0, null, null], [1, null, null], [null, 0, 1]] });
    expect(result).toMatchObject({ state: null, score: null, status: 'infeasible', method: 'exact' });
  });

  it('handles a disconnected row without infinite-potential arithmetic', () => {
    const result = assign({ costs: [[0, 1], [null, null]] });
    expect(result).toMatchObject({ state: null, score: null, status: 'infeasible' });
  });

  it('handles more tasks than agents as a proven infeasible assignment', () => {
    expect(assign({ costs: [[0], [1]] })).toMatchObject({ state: null, status: 'infeasible' });
  });

  it('finds a stable optimum under ties, forbidden edges and negative costs', () => {
    const problem = { costs: [[-2, -2, null], [-2, null, -2]] };
    const a = assign(problem), b = assign(problem);
    expect(a).toEqual(b); expect(a.score?.energy).toBe(-4); expect(a.optimal).toBe(true);
    expect(independentlyCheck(problem, a.state!)).toBe(-4);
  });

  it('compares the exact minimum with the budget without permitting overspend', () => {
    const costs = [[-4, 9], [8, 1]];
    expect(assign({ costs, budget: -3 })).toMatchObject({ status: 'valid', optimal: true });
    expect(assign({ costs, budget: -4 })).toMatchObject({ state: null, status: 'infeasible' });
  });

  it('keeps integer certificates exact when the total exceeds the per-cost bound', () => {
    for (const sign of [-1, 1]) {
      const problem = { costs: [[sign * 1e9, sign * 1e9], [sign * 1e9, sign * 1e9]], budget: sign * 2e9 };
      const result = assign(problem);
      expect(result.score?.energy).toBe(sign * 2e9);
      expect(result.optimal).toBe(true);
      expect(verifyAssignmentCertificate(problem, result.state!, result.certificate!)).toBe(true);
    }
  });

  it('keeps fractional costs valid without claiming an integer certificate', () => {
    const problem = { costs: [[0.125, 1.25], [3.5, -0.0625]], budget: 0.0625 };
    const result = assign(problem);
    expect(result.state).toEqual([0, 1]);
    expect(result.score?.energy).toBe(0.0625); expect(result.optimal).toBe(false);
    expect(independentlyCheck(problem, result.state!)).toBe(0.0625);
  });

  it('does not turn numerical budget uncertainty into proven infeasibility', () => {
    const result = assign({ costs: [[0.1, null], [null, 0.2]], budget: 0.3 });
    expect(result.state).toBeNull(); expect(result.optimal).toBe(false);
    expect(result.status).toBe('budget_exhausted');
  });

  it('enforces the exact operation budget separately from heuristic move counts', () => {
    const problem = { costs: [[1, 2], [3, 4]] };
    const result = assign(problem, { maxOperations: 0 });
    expect(result).toMatchObject({ state: null, status: 'budget_exhausted', operations: 0, optimal: false });
    expect(assign(problem, { maxOperations: 1 }).operations).toBeLessThanOrEqual(1);
    for (const maxOperations of [-1, 10_000_001, Infinity, 0.5]) {
      expect(() => assign(problem, { maxOperations })).toThrow();
    }
  });

  it('solves a full 64 by 64 assignment without pairwise mask expansion', () => {
    const problem = { costs: Array.from({ length: 64 }, (_, i) =>
      Array.from({ length: 64 }, (_, j) => i === j ? -3 : 1000)), budget: -192 };
    const result = assign(problem);
    expect(result.state).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(result.score?.energy).toBe(-192); expect(result.optimal).toBe(true);
    expect(verifyAssignmentCertificate(problem, result.state!, result.certificate!)).toBe(true);
  });

  it('supports sparse 32 by 64 problems with known optimum', () => {
    const problem = { costs: Array.from({ length: 32 }, (_, i) =>
      Array.from({ length: 64 }, (_, j) => j === i + 10 ? 0 : j === i ? 4 : null)) };
    const result = assign(problem);
    expect(result.score?.energy).toBe(0); expect(result.optimal).toBe(true);
    expect(independentlyCheck(problem, result.state!)).toBe(0);
  });

  it('checks certificate tightness, shape, signs and candidate validity independently', () => {
    const problem = { costs: [[1, 4, 9], [4, 1, 9]] };
    const result = assign(problem), certificate = result.certificate!;
    expect(result.optimal).toBe(true);
    const clone = () => ({ rowPotentials: [...certificate.rowPotentials], columnPotentials: [...certificate.columnPotentials] });
    const rowChanged = clone(); rowChanged.rowPotentials[0] += 1;
    const columnChanged = clone(); columnChanged.columnPotentials[2] = 1;
    const short = clone(); short.rowPotentials.pop();
    const nonfinite = clone(); nonfinite.rowPotentials[0] = NaN;
    for (const invalid of [rowChanged, columnChanged, short, nonfinite]) {
      expect(verifyAssignmentCertificate(problem, result.state!, invalid)).toBe(false);
    }
    expect(verifyAssignmentCertificate(problem, [0, 0], certificate)).toBe(false);
    expect(verifyAssignmentCertificate(problem, ['__proto__', 1] as unknown as number[], certificate)).toBe(false);
    expect(verifyAssignmentCertificate({ costs: [[2, 4, 9], [4, 1, 9]] }, result.state!, certificate)).toBe(false);
  });

  it('preserves heuristic search as an explicit uncertified strategy', () => {
    const problem = { costs: [[1, 2], [1, 99]] };
    const result = assign(problem, { strategy: 'energy', seed: 7, maxMoves: 1000 });
    expect(result.method).toBe('energy'); expect(result.optimal).toBe(false);
    expect(result.state).toEqual([1, 0]); expect(result.score?.energy).toBe(3);
  });

  it('rejects malformed matrices and costs outside the supported contract', () => {
    for (const costs of [[], [[0], [0, 1]], [[NaN]], [[Infinity]], [[1e9 + 1]], [[-1e9 - 1]]]) {
      expect(() => assign({ costs })).toThrow();
    }
    expect(() => assign({ costs: [Array(65).fill(0)] })).toThrow();
    expect(() => assign({ costs: Array.from({ length: 1025 }, () => [0]) })).toThrow();
    expect(() => assign({ costs: [[0]] }, { strategy: 'unsupported' as 'exact' })).toThrow();
  });
});
