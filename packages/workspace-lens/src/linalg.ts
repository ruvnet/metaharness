// SPDX-License-Identifier: MIT
//
// Minimal, dependency-free linear algebra for the runtime lens projection. This package NEVER fits a
// Jacobian (that needs a model backward pass — external); it only APPLIES a pre-fitted lens, which is a
// pair of matrix-vector products plus a softmax. So a few well-typed loops over Float64Array/number[]
// are all we need — no BLAS, no native deps, deterministic, and fast enough for per-request governance.

export type Vector = readonly number[];
/** Row-major dense matrix: `rows` arrays of length `cols`. */
export type Matrix = readonly Vector[];

/** y = M · x. Throws on a shape mismatch so a malformed lens artifact fails loudly, not silently. */
export function matVec(m: Matrix, x: Vector): number[] {
  if (m.length === 0) return [];
  const cols = m[0].length;
  if (cols !== x.length) {
    throw new Error(`matVec: matrix cols ${cols} != vector length ${x.length}`);
  }
  const out = new Array<number>(m.length);
  for (let i = 0; i < m.length; i++) {
    const row = m[i];
    if (row.length !== cols) throw new Error(`matVec: ragged matrix at row ${i} (${row.length} != ${cols})`);
    let s = 0;
    for (let j = 0; j < cols; j++) s += row[j] * x[j];
    out[i] = s;
  }
  return out;
}

export function dot(a: Vector, b: Vector): number {
  if (a.length !== b.length) throw new Error(`dot: length ${a.length} != ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]; 0 when either vector is all-zero (avoids NaN). */
export function cosine(a: Vector, b: Vector): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Numerically-stable softmax over logits → a probability distribution summing to 1. */
export function softmax(logits: Vector): number[] {
  if (logits.length === 0) return [];
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  const exps = new Array<number>(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - max);
    exps[i] = e;
    sum += e;
  }
  for (let i = 0; i < exps.length; i++) exps[i] /= sum;
  return exps;
}

/** Shannon entropy (nats) of a probability distribution. Higher = more diffuse workspace. */
export function entropy(probs: Vector): number {
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log(p);
  return h;
}

/**
 * Jensen–Shannon divergence between two distributions (nats, in [0, ln 2]). Symmetric + bounded, so it
 * is a stable per-step drift metric — unlike raw KL it never diverges to Infinity when a bin goes to 0.
 */
export function jensenShannon(p: Vector, q: Vector): number {
  if (p.length !== q.length) throw new Error(`jensenShannon: length ${p.length} != ${q.length}`);
  let d = 0;
  for (let i = 0; i < p.length; i++) {
    const m = (p[i] + q[i]) / 2;
    if (p[i] > 0 && m > 0) d += 0.5 * p[i] * Math.log(p[i] / m);
    if (q[i] > 0 && m > 0) d += 0.5 * q[i] * Math.log(q[i] / m);
  }
  // Clamp tiny negative from float error.
  return d < 0 ? 0 : d;
}

/** Indices of the top-k entries of `values`, highest first. Ties broken by lower index (stable). */
export function topKIndices(values: Vector, k: number): number[] {
  const idx = values.map((_, i) => i);
  idx.sort((a, b) => (values[b] - values[a]) || (a - b));
  return idx.slice(0, Math.max(0, k));
}
