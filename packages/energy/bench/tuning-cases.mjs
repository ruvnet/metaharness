// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';

// Independent full-state check. Never accept a missing or forbidden cost.
export function scoreState(model, state) {
  if (!Array.isArray(state) || state.length !== model.unary.length) return Infinity;
  let total = 0;
  for (let i = 0; i < state.length; i++) {
    const value = state[i];
    if (!Number.isInteger(value) || value < 0 || value >= model.unary[i].length) return Infinity;
    if (model.fixed?.[i] !== undefined && model.fixed[i] !== value) return Infinity;
    const cost = model.unary[i][value];
    if (!Number.isFinite(cost)) return Infinity;
    total += cost;
  }
  for (const { i, j, costs } of model.pairs ?? []) {
    const cost = costs[state[i]]?.[state[j]];
    if (!Number.isFinite(cost)) return Infinity;
    total += cost;
  }
  return total;
}

// Condition on the first variable, then use chain DP, closing the cycle at
// the end. This oracle assumes the ordered edges constructed below.
function ringMinimum(model) {
  const { unary, pairs, fixed } = model;
  const last = unary.length - 1;
  let best = Infinity;
  for (let first = 0; first < unary[0].length; first++) {
    if (fixed[0] !== undefined && fixed[0] !== first) continue;
    let prev = unary[0].map((cost, v) => v === first ? cost ?? Infinity : Infinity);
    for (let i = 1; i <= last; i++) {
      const costs = pairs[i - 1].costs;
      prev = unary[i].map((cost, next) => {
        if (cost === null || (fixed[i] !== undefined && fixed[i] !== next)) return Infinity;
        return cost + Math.min(...prev.map((value, v) => value + (costs[v][next] ?? Infinity)));
      });
    }
    for (let end = 0; end < prev.length; end++) {
      best = Math.min(best, prev[end] + (pairs[last].costs[first][end] ?? Infinity));
    }
  }
  return best;
}

function makeRing(id, unary, fixed, edge) {
  const pairs = [];
  for (let j = 1; j < unary.length; j++) pairs.push({ i: j - 1, j, costs: edge(j - 1, j) });
  pairs.push({ i: 0, j: unary.length - 1, costs: edge(0, unary.length - 1) });
  const model = { unary, fixed, pairs };
  const referenceEnergy = ringMinimum(model);
  if (!Number.isFinite(referenceEnergy)) throw new Error('Infeasible generated ring ' + id);
  return { id, model, referenceEnergy };
}

function syntheticSplit(label, seed) {
  let state = seed;
  const draw = n => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * n);
  };
  // Alternate binary and ternary rings. Each has a feasible witness, but
  // its random finite factors need not make that witness optimal.
  return Array.from({ length: 8 }, (_, k) => {
    const domain = 2 + k % 2;
    const n = 24 + draw(21);
    const witness = Array.from({ length: n }, () => draw(domain));
    const unary = witness.map(w => Array.from({ length: domain }, (_, v) =>
      v !== w && draw(16) === 0 ? null : 1 + draw(6)));
    const fixed = k % 2 === 0 ? { [n - 1]: witness[n - 1] } : {};
    return makeRing(label + '-' + k, unary, fixed, (i, j) =>
      unary[i].map((_, a) => unary[j].map((__, b) =>
        (a !== witness[i] || b !== witness[j]) && draw(16) === 0 ? null : draw(9))));
  });
}

export function syntheticCases() {
  const unary = Array.from({ length: 96 }, () => [0, 1]);
  const regressions = [
    makeRing('regression-smooth-96', unary, {}, () => [[0, 2], [2, 0]]),
    makeRing('regression-frustrated-96', unary, {}, () => [[3, 0], [0, 3]]),
  ];
  if (regressions[0].referenceEnergy !== 0 || regressions[1].referenceEnergy !== 48) {
    throw new Error('Published ring reference changed');
  }
  return { train: syntheticSplit('train', 131071), heldout: syntheticSplit('holdout', 524287), regressions };
}

// Held-out planner replay. Each reference is a feasible planner incumbent,
// not a claimed global optimum. Use unique case IDs in an anonymous export.
export function loadReplay(path) {
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('Expected a nonempty replay array');
  const ids = new Set();
  return rows.map(({ id, model, referenceState, baselineCpuMs }) => {
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new TypeError('Invalid or duplicate replay id');
    ids.add(id);
    if (!Array.isArray(model?.unary) || !model.unary.length) throw new TypeError('Missing replay model for ' + id);
    const referenceEnergy = scoreState(model, referenceState);
    if (!Number.isFinite(referenceEnergy)) throw new TypeError('Invalid replay reference state for ' + id);
    if (baselineCpuMs !== undefined && (!Number.isFinite(baselineCpuMs) || baselineCpuMs <= 0)) {
      throw new TypeError('Expected positive baselineCpuMs for ' + id);
    }
    return { id, model, referenceEnergy, ...(baselineCpuMs === undefined ? {} : { baselineCpuMs }) };
  });
}
