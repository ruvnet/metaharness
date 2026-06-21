// SPDX-License-Identifier: MIT
//
// Darwin Shield — shared, dependency-free primitives (ADR-155).
//
// Everything in the security module is deterministic and reproducible: the same
// inputs (and seed) always yield byte-identical outputs, so a run is replayable
// from its receipts (ADR-155 acceptance: "all runs reproducible from receipts").
// These three helpers are the substrate for that guarantee.

/**
 * mulberry32 — a tiny, fast, deterministic 32-bit PRNG (mirrors bench/stats.ts).
 * Seeding it makes population sampling, mutation choice, and bootstrap statistics
 * reproducible. Returns a stateful generator producing floats in [0, 1).
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Round to 6 decimal places. Kills float-representation noise so scores and
 * receipts are byte-identical across runs (ADR-155 reproducibility). The leading
 * `+` drops any `-0`.
 */
export function round6(value: number): number {
  return +(Math.round(value * 1e6) / 1e6).toFixed(6);
}

/** Deterministic 32-bit FNV-1a hash of a string. The embedding seed. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic, dependency-free "embedding": a fixed-dimension unit vector
 * derived from a string's tokens. This is NOT a learned model — it is a
 * reproducible stand-in for ruVector's embedder (ADR-074/155) that gives stable
 * cosine similarities for the retrieval tests, with no network and no weights.
 * Token-bag hashing means semantically-overlapping text shares dimensions, so
 * similar code/queries score higher — enough to exercise the ranking math.
 */
export function embed(text: string, dim = 64): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % dim;
    // Sign from a second hash bit so collisions can cancel (random projection).
    const sign = (h & 0x10000) === 0 ? 1 : -1;
    v[idx] += sign;
  }
  return normalize(v);
}

/** L2-normalise a vector to a unit vector (zero vector stays zero). */
export function normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}

/** Cosine similarity of two equal-length vectors, clamped to [0,1] for ranking. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  // Inputs are unit vectors, so dot ∈ [-1,1]; clamp the negative half to 0 since
  // ranking only cares about positive similarity.
  return dot < 0 ? 0 : dot > 1 ? 1 : dot;
}

/** Clamp `x` into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
