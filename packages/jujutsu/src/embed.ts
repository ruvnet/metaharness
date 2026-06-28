// SPDX-License-Identifier: MIT
//
// Offline, dependency-free embedder used to turn an op-sequence into a vector
// for the agenticow memory branch. It is deterministic and zero-cost so the
// bridge runs with no model/network — but it is a PLACEHOLDER. Production
// should inject a real embedder (ONNX all-MiniLM-L6-v2, etc.) via the
// `Embedder` interface; the bridge depends only on the interface.

/** Anything that turns text into a fixed-dimension vector. */
export interface Embedder {
  readonly dimension: number;
  embed(text: string): Float32Array;
}

/**
 * Deterministic hashing embedder (feature hashing + L2 normalize). Same text
 * always yields the same vector; similar token sets yield closer vectors. Not
 * semantically rich — swap for a real model in production.
 */
export class HashEmbedder implements Embedder {
  constructor(public readonly dimension: number = 384) {
    if (dimension <= 0) throw new Error('HashEmbedder: dimension must be > 0');
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dimension);
    const tokens = String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const tok of tokens) {
      const h = fnv1a(tok);
      const idx = h % this.dimension;
      // sign hashing reduces collisions cancelling vs reinforcing arbitrarily
      const sign = (h >>> 31) & 1 ? -1 : 1;
      v[idx] += sign;
    }
    // L2 normalize for cosine geometry (agenticow default metric).
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }
}

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
