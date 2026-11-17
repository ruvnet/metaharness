// SPDX-License-Identifier: MIT
/** A null cost is forbidden. Finite costs express preferences, never authority. */
export type Cost = number | null;
export interface Pair { i: number; j: number; costs: Cost[][] }
export interface EnergyModel { unary: Cost[][]; pairs?: Pair[]; fixed?: Record<number, number> }
export interface Score { violations: number; energy: number }
export interface SearchOptions {
  seed?: number; maxMoves?: number; restarts?: number; temperature?: number;
  initial?: number[];
  /** Force sparse deltas or reference recomputation. Default selects by graph size/density. */
  incremental?: boolean;
}
export interface SearchResult {
  state: number[] | null; score: Score | null; moves: number;
  status: 'valid' | 'budget_exhausted'; optimal: false;
}
const integer = (v: number, lo: number, hi: number, name: string): number => {
  if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new RangeError(name);
  return v;
};
const finite = (v: number, name: string): number => {
  if (!Number.isFinite(v) || Math.abs(v) > 1e9) throw new RangeError(name);
  return v;
};
export function random(seed: number): () => number {
  integer(seed, 0, 0xffffffff, 'seed');
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function snapshot(input: EnergyModel): Required<EnergyModel> {
  integer(input.unary.length, 1, 1024, 'variables');
  let entries = 0;
  const row = (r: Cost[]) => {
    integer(r.length, 1, 64, 'domain');
    entries += r.length;
    if (entries > 1_000_000) throw new RangeError('model entry budget');
    return Array.from(r, c => c === null ? null : finite(c, 'cost'));
  };
  const unary = Array.from(input.unary, row);
  const seen = new Set<string>();
  const pairs = Array.from(input.pairs ?? [], p => {
    integer(p.i, 0, unary.length - 1, 'pair.i');
    integer(p.j, p.i + 1, unary.length - 1, 'pair.j must exceed i');
    const key = `${p.i}:${p.j}`;
    if (seen.has(key)) throw new RangeError('duplicate pair');
    seen.add(key);
    if (p.costs.length !== unary[p.i].length) throw new RangeError('pair rows');
    const costs = Array.from(p.costs, r => {
      if (r.length !== unary[p.j].length) throw new RangeError('pair columns');
      return row(r);
    });
    return { i: p.i, j: p.j, costs };
  });
  const fixed: Record<number, number> = {};
  for (const [k, v] of Object.entries(input.fixed ?? {})) {
    const i = integer(Number(k), 0, unary.length - 1, 'fixed variable');
    fixed[i] = integer(v, 0, unary[i].length - 1, 'fixed value');
    if (unary[i][v] === null) throw new RangeError('forbidden fixed value');
  }
  return { unary, pairs, fixed };
}
function checkState(m: Required<EnergyModel>, state: number[]): void {
  if (state.length !== m.unary.length) throw new RangeError('state length');
  for (let i = 0; i < state.length; i++) integer(state[i], 0, m.unary[i].length - 1, 'state value');
}
function full(m: Required<EnergyModel>, s: number[]): Score {
  let violations = 0, energy = 0;
  const add = (c: Cost) => { if (c === null) violations++; else energy += c; };
  for (let i = 0; i < s.length; i++) {
    add(m.unary[i][s[i]]);
    if (m.fixed[i] !== undefined && m.fixed[i] !== s[i]) violations++;
  }
  for (const p of m.pairs) add(p.costs[s[p.i]][s[p.j]]);
  return { violations, energy };
}
/** Independent full evaluation, including hard constraints and clamped values. */
export function evaluate(model: EnergyModel, state: number[]): Score {
  const m = snapshot(model); checkState(m, state); return full(m, state);
}
function better(a: Score, b: Score): boolean {
  return a.violations < b.violations || (a.violations === b.violations && a.energy < b.energy);
}
/** Bounded stochastic local search. Finding a fixed point does not prove optimality. */
export function solve(model: EnergyModel, opts: SearchOptions = {}): SearchResult {
  const m = snapshot(model), rng = random(opts.seed ?? 1);
  const maxMoves = integer(opts.maxMoves ?? 4000, 0, 1_000_000, 'maxMoves');
  const restarts = integer(opts.restarts ?? 8, 1, 1024, 'restarts');
  const temperature = finite(opts.temperature ?? 1, 'temperature');
  if (temperature < 0) throw new RangeError('temperature');
  if (opts.initial) checkState(m, opts.initial);
  const free = m.unary.map((_, i) => i).filter(i => m.fixed[i] === undefined);
  const adjacency: number[][] = m.unary.map(() => []);
  m.pairs.forEach((p, e) => { adjacency[p.i].push(e); adjacency[p.j].push(e); });
  // Tiny/dense graphs cost less to recompute than to gather incident edges.
  // This is a performance choice only; both paths share validation semantics.
  const incremental = opts.incremental ?? (m.unary.length >= 16 && m.pairs.length <= m.unary.length * 4);
  // Scratch marks avoid Set allocation in the search hot path. Each incident
  // edge must be counted exactly once, including when both ends change.
  const marks = new Uint32Array(m.pairs.length);
  let stamp = 0, moves = 0, best: number[] | null = null, bestScore: Score | null = null;
  const remember = (s: number[], score: Score) => {
    if (score.violations === 0 && (!bestScore || score.energy < bestScore.energy)) {
      best = s.slice(); bestScore = { ...score };
    }
  };
  for (let r = 0; r < restarts; r++) {
    const s = m.unary.map((u, i) => m.fixed[i] ??
      (r === 0 && opts.initial ? opts.initial[i] : Math.floor(rng() * u.length)));
    let score = full(m, s); remember(s, score);
    if (!free.length || maxMoves === 0) break;
    const limit = Math.floor(maxMoves * (r + 1) / restarts);
    while (moves < limit) {
      const i = free[Math.floor(rng() * free.length)];
      const oldI = s[i];
      let j = i, oldJ = oldI;
      let newI = Math.floor(rng() * m.unary[i].length), newJ = newI;
      // Swaps cross assignment barriers that single-variable updates cannot.
      if (free.length > 1 && rng() < 0.5) {
        j = free[Math.floor(rng() * free.length)]; oldJ = s[j];
        if (oldJ < m.unary[i].length && oldI < m.unary[j].length) {
          newI = oldJ; newJ = oldI;
        } else { j = i; oldJ = oldI; }
      }
      let next: Score;
      if (!incremental) {
        s[i] = newI; if (j !== i) s[j] = newJ;
        next = full(m, s);
      } else {
        let dv = 0, de = 0;
        const diff = (a: Cost, b: Cost) => {
          dv += Number(b === null) - Number(a === null);
          de += (b ?? 0) - (a ?? 0);
        };
        diff(m.unary[i][oldI], m.unary[i][newI]);
        if (j !== i) diff(m.unary[j][oldJ], m.unary[j][newJ]);
        stamp++;
        for (const cell of j === i ? [i] : [i, j]) for (const e of adjacency[cell]) {
          if (marks[e] === stamp) continue;
          marks[e] = stamp;
          const p = m.pairs[e];
          const a = p.i === i ? newI : p.i === j ? newJ : s[p.i];
          const b = p.j === i ? newI : p.j === j ? newJ : s[p.j];
          diff(p.costs[s[p.i]][s[p.j]], p.costs[a][b]);
        }
        next = { violations: score.violations + dv, energy: score.energy + de };
        s[i] = newI; if (j !== i) s[j] = newJ;
      }
      const t = temperature * Math.max(0.01, 1 - moves / Math.max(1, maxMoves));
      const accept = better(next, score) ||
        (next.violations === score.violations &&
          (next.energy === score.energy || (t > 0 && rng() < Math.exp((score.energy - next.energy) / t))));
      if (accept) { score = next; remember(s, score); }
      else { s[i] = oldI; if (j !== i) s[j] = oldJ; }
      moves++;
    }
  }
  // Recompute from original costs before reporting validity. Incremental
  // arithmetic and stopping heuristics are never a constraint certificate.
  const verified = best ? full(m, best) : null;
  if (verified && verified.violations !== 0) throw new Error('internal validation failed');
  return { state: best, score: verified, moves, status: best ? 'valid' : 'budget_exhausted', optimal: false };
}

export interface AssignmentProblem {
  /** Rows are tasks, columns are agents; null denies that task/agent pair. */
  costs: Cost[][];
  /** At most one task per agent in this scheduling wave. */
  budget?: number;
}
export function validateAssignment(problem: AssignmentProblem, state: number[]): boolean {
  if (!Array.isArray(state) || state.length !== problem.costs.length) return false;
  const used = new Set<number>(); let cost = 0;
  for (let i = 0; i < state.length; i++) {
    const a = state[i];
    if (!Number.isSafeInteger(a) || a < 0 || a >= problem.costs[i].length || used.has(a)) return false;
    const c = problem.costs[i][a];
    if (c === null || !Number.isFinite(c)) return false;
    used.add(a); cost += c;
  }
  return Number.isFinite(cost) && (problem.budget === undefined ||
    (Number.isFinite(problem.budget) && cost <= problem.budget));
}
/** Proposals only. The caller still enforces current permissions on execution. */
export function assign(problem: AssignmentProblem, opts: SearchOptions = {}): SearchResult {
  const m = snapshot({ unary: problem.costs });
  if (problem.budget !== undefined) finite(problem.budget, 'budget');
  if (m.unary.some(u => u.length !== m.unary[0].length)) throw new RangeError('rectangular costs');
  const n = m.unary.length, c = m.unary[0].length;
  if (n * c + n * (n - 1) / 2 * c * c > 1_000_000) throw new RangeError('assignment entry budget');
  const pairs: Pair[] = [];
  for (let i = 0; i < m.unary.length; i++) for (let j = i + 1; j < m.unary.length; j++) {
    pairs.push({ i, j, costs: m.unary[i].map((_, a) => m.unary[j].map((_, b) => a === b ? null : 0)) });
  }
  // Greedy seed is an incumbent, not a proof of feasibility or optimality.
  const used = new Set<number>();
  const initial = m.unary.map(u => {
    let best = -1;
    for (let a = 0; a < u.length; a++) if (!used.has(a) && u[a] !== null &&
      (best < 0 || u[a]! < u[best]!)) best = a;
    if (best < 0) best = 0;
    used.add(best); return best;
  });
  const result = solve({ unary: m.unary, pairs }, { ...opts, initial: opts.initial ?? initial });
  if (result.state && !validateAssignment(problem, result.state)) {
    return { ...result, state: null, score: null, status: 'budget_exhausted' };
  }
  return result;
}

export interface FitOptions { epochs?: number; learningRate?: number }
export interface FitResult { model: EnergyModel; initialLoss: number; finalLoss: number }
/** Local pseudolikelihood SGD, without differentiating through search.
 * Hard null masks and fixed values are immutable. Labels must be verified by
 * the caller; syntactic feasibility here does not establish label provenance.
 */
export function fit(model: EnergyModel, examples: number[][], opts: FitOptions = {}): FitResult {
  const m = snapshot(model);
  integer(examples.length, 1, 1000, 'examples');
  integer(m.unary.length, 1, 64, 'training variables');
  const epochs = integer(opts.epochs ?? 50, 1, 1000, 'epochs');
  const lr = finite(opts.learningRate ?? 0.05, 'learningRate');
  if (lr <= 0 || lr > 10) throw new RangeError('learningRate');
  const labels = Array.from(examples, s => {
    checkState(m, s);
    if (full(m, s).violations) throw new RangeError('infeasible example');
    return s.slice();
  });
  const adjacency: Pair[][] = m.unary.map(() => []);
  for (const p of m.pairs) { adjacency[p.i].push(p); adjacency[p.j].push(p); }
  const work = m.unary.reduce((n, u, i) => n + u.length * (1 + adjacency[i].length), 0);
  if (epochs * examples.length * work > 20_000_000) throw new RangeError('training work budget');
  const conditional = (s: number[], i: number) => {
    const energies = m.unary[i].map((u, a) => {
      if (u === null) return Infinity;
      let e = u;
      for (const p of adjacency[i]) {
        const v = p.i === i ? p.costs[a][s[p.j]] : p.costs[s[p.i]][a];
        if (v === null) return Infinity;
        e += v;
      }
      return e;
    });
    const min = Math.min(...energies);
    const weights = energies.map(e => Math.exp(min - e));
    const z = weights.reduce((a, b) => a + b, 0);
    return { energies, probabilities: weights.map(w => w / z), logZ: Math.log(z) - min };
  };
  const loss = () => {
    let sum = 0, count = 0;
    for (const s of labels) for (let i = 0; i < s.length; i++) if (m.fixed[i] === undefined) {
      const q = conditional(s, i); sum += q.energies[s[i]] + q.logZ; count++;
    }
    return count ? sum / count : 0;
  };
  const initialLoss = loss();
  for (let epoch = 0; epoch < epochs; epoch++) for (const s of labels) {
    for (let i = 0; i < s.length; i++) if (m.fixed[i] === undefined) {
      const q = conditional(s, i);
      for (let a = 0; a < m.unary[i].length; a++) {
        if (!Number.isFinite(q.energies[a])) continue;
        const gradient = Number(a === s[i]) - q.probabilities[a];
        m.unary[i][a] = m.unary[i][a]! - lr * gradient;
        for (const p of adjacency[i]) {
          const row = p.i === i ? a : s[p.i], col = p.i === i ? s[p.j] : a;
          p.costs[row][col] = p.costs[row][col]! - lr * gradient;
        }
      }
    }
  }
  return { model: m, initialLoss, finalLoss: loss() };
}
