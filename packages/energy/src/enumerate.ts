// SPDX-License-Identifier: MIT
import type { EnergyModel, Pair } from './index.js';

interface EnumerationResult {
  state: number[] | null;
  status: 'valid' | 'infeasible' | 'budget_exhausted';
  operations: number;
}

/** Exact iterative branch and bound on a normalized integer model.
 * One operation inspects one unary or pair term of a candidate extension.
 * Initial validation, bounded domain ordering and one scan of the supplied
 * factor tables to construct admissible minima are outside that counter.
 */
export function enumerateEnergy(
  model: Required<EnergyModel>, maxOperations: number, incumbent?: { state: number[]; energy: number },
): EnumerationResult {
  let bestEnergy = incumbent?.energy ?? Infinity;
  let best = incumbent?.state ?? null;
  let operations = 0;
  const result = (status: EnumerationResult['status']): EnumerationResult =>
    ({ state: best, status, operations });
  if (maxOperations === 0) return result('budget_exhausted');

  const n = model.unary.length;
  const domains = model.unary.map((row, i) => {
    const values: number[] = [];
    for (let v = 0; v < row.length; v++) {
      if (row[v] !== null && (model.fixed[i] === undefined || model.fixed[i] === v)) values.push(v);
    }
    return values.sort((a, b) => row[a]! - row[b]! || a - b);
  });
  if (domains.some(values => values.length === 0)) return result('infeasible');
  const unaryMin = domains.map((values, i) => model.unary[i][values[0]]!);
  let floor = unaryMin.reduce((sum, cost) => sum + cost, 0);

  const degree = new Uint32Array(n);
  for (const { i, j } of model.pairs) { degree[i]++; degree[j]++; }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
    domains[a].length - domains[b].length || degree[b] - degree[a] || a - b);
  const rank = new Uint32Array(n);
  order.forEach((variable, depth) => { rank[variable] = depth; });
  // Each pair enters the bound exactly once when its second endpoint is set.
  const incoming = Array.from({ length: n }, (): { pair: Pair; min: number }[] => []);
  for (const pair of model.pairs) {
    let min = Infinity;
    for (const a of domains[pair.i]) for (const b of domains[pair.j]) {
      const cost = pair.costs[a][b];
      if (cost !== null && cost < min) min = cost;
    }
    if (min === Infinity) return result('infeasible');
    floor += min;
    incoming[Math.max(rank[pair.i], rank[pair.j])].push({ pair, min });
  }
  if (bestEnergy === floor) return result('valid');

  // At depth d, bounds[d] includes the exact cost of every fully assigned
  // term and the independent minimum of every remaining term. Replacing a
  // minimum can only increase the bound, including for negative costs.
  const bounds = new Float64Array(n + 1);
  bounds[0] = floor;
  const cursor = new Uint32Array(n);
  const state = Array<number>(n);
  let depth = 0;
  while (depth >= 0) {
    const i = order[depth];
    if (cursor[depth] === domains[i].length || bounds[depth] >= bestEnergy) {
      depth--;
      continue;
    }
    if (operations === maxOperations) return result('budget_exhausted');
    operations++;
    const value = domains[i][cursor[depth]++];
    state[i] = value;
    let bound = bounds[depth] + model.unary[i][value]! - unaryMin[i];
    for (const { pair, min } of incoming[depth]) {
      if (bound >= bestEnergy) break;
      if (operations === maxOperations) return result('budget_exhausted');
      operations++;
      const cost = pair.costs[state[pair.i]][state[pair.j]];
      if (cost === null) { bound = Infinity; break; }
      bound += cost - min;
    }
    if (bound >= bestEnergy) continue;
    if (depth + 1 === n) {
      bestEnergy = bound;
      best = state.slice();
      if (bestEnergy === floor) break;
    } else {
      depth++;
      bounds[depth] = bound;
      cursor[depth] = 0;
    }
  }
  return result(best ? 'valid' : 'infeasible');
}
