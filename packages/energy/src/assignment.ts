// SPDX-License-Identifier: MIT
import type { Cost } from './index.js';

export interface AssignmentCertificate {
  rowPotentials: number[];
  columnPotentials: number[];
}
interface MatchingResult {
  state: number[] | null;
  status: 'matched' | 'infeasible' | 'budget_exhausted';
  operations: number;
  certificate?: AssignmentCertificate;
}

/** Rectangular shortest augmenting path Hungarian algorithm, O(n*n*m).
 * Inputs are normalized by the public adapter. Null edges are never relaxed.
 * No fabricated large penalty is substituted for a forbidden edge.
 */
export function exactMatching(costs: Cost[][], maxOperations: number): MatchingResult {
  const n = costs.length, m = costs[0].length;
  let operations = 0;
  const empty = (status: 'infeasible' | 'budget_exhausted'): MatchingResult => ({ state: null, status, operations });
  if (n > m) return empty('infeasible');
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  const min = new Float64Array(m + 1), used = new Uint8Array(m + 1);
  for (let row = 1; row <= n; row++) {
    p[0] = row; min.fill(Infinity); used.fill(0);
    let j0 = 0;
    do {
      used[j0] = 1;
      const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        if (operations >= maxOperations) return empty('budget_exhausted');
        operations++;
        const cost = costs[i0 - 1][j - 1];
        if (cost !== null) {
          const reduced = cost - u[i0] - v[j];
          if (reduced < min[j]) { min[j] = reduced; way[j] = j0; }
        }
        // Earlier alternating-tree rows may already have reached this column.
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      if (!Number.isFinite(delta)) return empty('infeasible');
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const state = Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) state[p[j] - 1] = j - 1;
  return { state, status: 'matched', operations,
    certificate: { rowPotentials: Array.from(u.subarray(1)), columnPotentials: Array.from(v.subarray(1)) } };
}

/** Check primal feasibility, dual feasibility and complementary slackness.
 * Strict safe-integer arithmetic only. There is no tolerance that can turn
 * an approximately feasible float certificate into a mathematical guarantee.
 */
export function verifyMatching(costs: Cost[][], state: number[], cert: AssignmentCertificate): boolean {
  const n = costs.length, m = costs[0].length;
  const u = cert.rowPotentials, v = cert.columnPotentials;
  if (!Array.isArray(u) || !Array.isArray(v) || u.length !== n || v.length !== m || state.length !== n) return false;
  const used = new Uint8Array(m); let primal = 0, dual = 0;
  for (let j = 0; j < m; j++) {
    if (!Number.isSafeInteger(v[j]) || v[j] > 0) return false;
    dual += v[j];
  }
  for (let i = 0; i < n; i++) {
    const a = state[i];
    if (!Number.isSafeInteger(u[i]) || !Number.isSafeInteger(a) || a < 0 || a >= m || used[a]) return false;
    const matched = costs[i][a];
    if (matched === null || !Number.isSafeInteger(matched) || u[i] + v[a] !== matched) return false;
    used[a] = 1; primal += matched; dual += u[i];
    for (let j = 0; j < m; j++) {
      const c = costs[i][j];
      if (c !== null && (!Number.isSafeInteger(c) || u[i] + v[j] > c)) return false;
    }
  }
  for (let j = 0; j < m; j++) if (!used[j] && v[j] !== 0) return false;
  return Number.isSafeInteger(primal) && Number.isSafeInteger(dual) && primal === dual;
}
