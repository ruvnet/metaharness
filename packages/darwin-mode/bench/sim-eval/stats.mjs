// SPDX-License-Identifier: MIT
//
// Pre-registered statistics for the #523 sealed SIM evaluation. Pure.
//
// Unit of analysis: one (model, benchmark, seed) cell-replicate. A contrast is
// the per-seed paired difference arm − control within each (model, benchmark)
// cell. The estimate is the equal-weight mean of cell means; its CI is a
// cell-STRATIFIED paired bootstrap (resample seeds with replacement inside each
// cell). The p-value is a sign-flip permutation test on the same statistic.

import { rng } from './tasks.mjs';

export const PROMOTION_THRESHOLD = 0.02; // 2 held-out percentage points
export const EQUIVALENCE_MARGIN = 0.02;

/**
 * Pair rows by (model, bench, seed). `rows` carry { model, bench, seed, arm, value }.
 * Returns Map<cellKey, number[]> of arm − control deltas, ordered by seed.
 */
export function pairedDeltas(rows, arm, control, value = (r) => r.value) {
  const key = (r) => `${r.model}|${r.bench}|${r.seed}`;
  const ctl = new Map(rows.filter((r) => r.arm === control).map((r) => [key(r), r]));
  const cells = new Map();
  for (const r of rows.filter((x) => x.arm === arm).sort((a, b) => a.seed - b.seed)) {
    const c = ctl.get(key(r));
    if (!c) continue; // unpaired (e.g. aborted control run) — excluded, reported by caller
    const ck = `${r.model}|${r.bench}`;
    if (!cells.has(ck)) cells.set(ck, []);
    cells.get(ck).push(value(r) - value(c));
  }
  return cells;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Equal-weight mean of per-cell means. */
export function cellMean(cells) {
  const ms = [...cells.values()].filter((d) => d.length > 0).map(mean);
  return ms.length ? mean(ms) : NaN;
}

/** Cell-stratified paired bootstrap percentile CI. */
export function stratifiedBootstrap(cells, { reps = 10_000, alpha = 0.05, seed = 523 } = {}) {
  const r = rng(seed);
  const arrays = [...cells.values()].filter((d) => d.length > 0);
  const stats = new Float64Array(reps);
  for (let b = 0; b < reps; b++) {
    let total = 0;
    for (const d of arrays) {
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[Math.floor(r() * d.length)];
      total += s / d.length;
    }
    stats[b] = total / arrays.length;
  }
  stats.sort();
  const at = (q) => stats[Math.min(reps - 1, Math.max(0, Math.floor(q * reps)))];
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2) };
}

/** Two-sided sign-flip permutation p-value for the cell-mean statistic. */
export function signFlipP(cells, { reps = 20_000, seed = 524 } = {}) {
  const arrays = [...cells.values()].filter((d) => d.length > 0);
  const observed = Math.abs(cellMean(cells));
  if (!Number.isFinite(observed)) return NaN;
  const r = rng(seed);
  let extreme = 0;
  for (let b = 0; b < reps; b++) {
    let total = 0;
    for (const d of arrays) {
      let s = 0;
      for (const x of d) s += r() < 0.5 ? -x : x;
      total += s / d.length;
    }
    if (Math.abs(total / arrays.length) >= observed - 1e-12) extreme++;
  }
  return (extreme + 1) / (reps + 1);
}

/** Holm step-down adjustment; returns adjusted p-values in input order. */
export function holm(ps) {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(ps.length);
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    out[i] = running;
  });
  return out;
}

/**
 * Pre-registered verdict for a held-out contrast (values are fractions, 0.02 = 2pt):
 *   gain        — estimate ≥ +threshold AND CI lower bound > 0
 *   negative    — CI upper bound < 0
 *   null        — CI inside (−margin, +margin) (practical equivalence)
 *   inconclusive— anything else (underpowered for the 2pt question)
 */
export function verdict({ estimate, lo, hi }, threshold = PROMOTION_THRESHOLD, margin = EQUIVALENCE_MARGIN) {
  if (![estimate, lo, hi].every(Number.isFinite)) return 'insufficient-data';
  if (estimate >= threshold && lo > 0) return 'gain';
  if (hi < 0) return 'negative';
  if (lo > -margin && hi < margin) return 'null';
  return 'inconclusive';
}

/** Full contrast report. `alpha` is the per-contrast CI level after multiplicity. */
export function contrast(rows, arm, control, opts = {}) {
  const cells = pairedDeltas(rows, arm, control, opts.value);
  const n = [...cells.values()].reduce((s, d) => s + d.length, 0);
  const estimate = cellMean(cells);
  const { lo, hi } = n > 0 ? stratifiedBootstrap(cells, { alpha: opts.alpha ?? 0.05 }) : { lo: NaN, hi: NaN };
  const p = n > 0 ? signFlipP(cells) : NaN;
  return { arm, control, pairs: n, cells: cells.size, estimate, lo, hi, p, verdict: verdict({ estimate, lo, hi }) };
}

/** Quantile of an array (nearest-rank on sorted copy). */
export function quantile(xs, q) {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
}

/** Bootstrap CI for a ratio of sums (e.g. USD per held-out solve) over rows. */
export function ratioCi(rows, num, den, { reps = 5_000, seed = 525 } = {}) {
  if (rows.length === 0) return { estimate: NaN, lo: NaN, hi: NaN };
  const ratio = (rs) => {
    const d = rs.reduce((s, x) => s + den(x), 0);
    return d > 0 ? rs.reduce((s, x) => s + num(x), 0) / d : NaN;
  };
  const r = rng(seed);
  const stats = [];
  for (let b = 0; b < reps; b++) {
    const sample = rows.map(() => rows[Math.floor(r() * rows.length)]);
    const v = ratio(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  return { estimate: ratio(rows), lo: quantile(stats, 0.025), hi: quantile(stats, 0.975) };
}
