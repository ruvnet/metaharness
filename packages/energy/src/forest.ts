// SPDX-License-Identifier: MIT
import type { EnergyModel } from './index.js';

export interface ForestOrder {
  vertices: number[];
  parent: Int32Array;
  parentEdge: Int32Array;
}

/** Orient each tree from its lowest numbered vertex. The input is normalized:
 * edges are undirected, have distinct endpoints, and occur at most once.
 */
export function forestOrder(model: Required<EnergyModel>): ForestOrder | null {
  const count = model.unary.length;
  if (model.pairs.length >= count) return null;
  const incident: number[][] = Array.from({ length: count }, () => []);
  for (const [index, pair] of model.pairs.entries()) {
    incident[pair.i].push(index);
    incident[pair.j].push(index);
  }

  const vertices: number[] = [];
  const parent = new Int32Array(count).fill(-1);
  const parentEdge = new Int32Array(count).fill(-1);
  for (let root = 0; root < count; root++) {
    if (parent[root] !== -1) continue;
    parent[root] = root;
    let cursor = vertices.length;
    vertices.push(root);
    while (cursor < vertices.length) {
      const vertex = vertices[cursor++];
      for (const index of incident[vertex]) {
        if (index === parentEdge[vertex]) continue;
        const pair = model.pairs[index];
        const neighbor = pair.i === vertex ? pair.j : pair.i;
        if (parent[neighbor] !== -1) return null;
        parent[neighbor] = vertex;
        parentEdge[neighbor] = index;
        vertices.push(neighbor);
      }
    }
  }
  return { vertices, parent, parentEdge };
}

interface ForestResult {
  state: number[] | null;
  status: 'valid' | 'infeasible' | 'budget_exhausted';
  operations: number;
}

/** Each child sends its minimum subtree cost conditional on its parent's value.
 * Subtrees share only their parent, so summing their messages is exact. Public
 * integer cost and model size limits keep every finite sum within safe range.
 * One operation inspects one unary candidate or one parent/child transition.
 */
export function solveForest(model: Required<EnergyModel>, order: ForestOrder, maxOperations: number): ForestResult {
  let operations = 0;
  const empty = (status: 'infeasible' | 'budget_exhausted'): ForestResult => ({ state: null, status, operations });
  if (maxOperations === 0) return empty('budget_exhausted');

  const subtree = model.unary.map(row => new Float64Array(row.length));
  const choice: Int16Array[] = [];
  const state = new Array<number>(model.unary.length);
  for (let k = order.vertices.length - 1; k >= 0; k--) {
    const child = order.vertices[k];
    const scores = subtree[child];
    const row = model.unary[child];
    const fixed = model.fixed[child];
    let bestValue = -1;
    let minimum = Infinity;
    for (let value = 0; value < row.length; value++) {
      if (operations === maxOperations) return empty('budget_exhausted');
      operations++;
      const cost = row[value];
      if (cost === null || (fixed !== undefined && value !== fixed)) scores[value] = Infinity;
      else scores[value] += cost;
      if (scores[value] < minimum) {
        minimum = scores[value];
        bestValue = value;
      }
    }
    if (bestValue < 0) return empty('infeasible');

    const parent = order.parent[child];
    if (parent === child) {
      state[child] = bestValue;
      continue;
    }
    const pair = model.pairs[order.parentEdge[child]];
    const parentScores = subtree[parent];
    const winners = new Int16Array(parentScores.length);
    choice[child] = winners;
    for (let p = 0; p < parentScores.length; p++) {
      let message = Infinity;
      for (let c = 0; c < scores.length; c++) {
        if (operations === maxOperations) return empty('budget_exhausted');
        operations++;
        const cost = pair.i === parent ? pair.costs[p][c] : pair.costs[c][p];
        if (cost === null) continue;
        const total = scores[c] + cost;
        if (total < message) {
          message = total;
          winners[p] = c;
        }
      }
      parentScores[p] += message;
    }
  }

  // Only reachable parent values are followed, in parent-before-child order.
  for (const vertex of order.vertices) {
    const parent = order.parent[vertex];
    if (parent !== vertex) state[vertex] = choice[vertex][state[parent]];
  }
  return { state, status: 'valid', operations };
}
