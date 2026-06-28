// SPDX-License-Identifier: MIT
//
// embedder.mjs — keyless, deterministic, $0 text embedder for the ADR-201 ablation.
//
// WHY HAND-ROLLED: ruvector@0.2.32 ships `MockEmbeddingProvider` and `LocalNGramProvider`,
// but BOTH are stubs at this version — MockEmbeddingProvider returns `[[]]` (empty) and
// LocalNGramProvider returns a length-1 vector (verified at runtime, 2026-06-28). The real
// `EmbeddingService`/`OnnxEmbedder` works but pulls an ONNX model (all-MiniLM) on first use.
// For a deterministic, offline, network-free dense baseline we use a hashed bag-of-bigrams
// embedder here. It is the SAME embedder fed to BOTH arms (Control dense AND Test ruvector),
// so the A/B comparison isolates the *index/memory layer*, not the embedding model. The real
// frontier run can swap this for OnnxEmbedder or an OpenRouter embedding model via the
// `embed` hook on the memory layer (see memory-layer.mjs) — the seam is removable (ADR-150).
//
// Properties: deterministic (same text -> same vector), keyless, $0, L2-normalized so cosine
// == dot product. Good enough to separate topically-distinct passages; NOT semantic-grade.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash of a string -> unsigned int. */
function fnv1a(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, FNV_PRIME); }
  return h >>> 0;
}

/** Tokenize to lowercase alnum word tokens. */
function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

/**
 * Embed a single string into a dense, L2-normalized Float32Array of length `dim`.
 * Uses hashed unigrams + bigrams (a tiny "word hashing trick" / feature hashing).
 */
export function embedText(text, dim = 256) {
  const v = new Float32Array(dim);
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    const uni = toks[i];
    const hu = fnv1a(uni);
    v[hu % dim] += 1 + (((hu >>> 16) & 1) ? -2 : 0) * 0; // sign trick below keeps it simple/positive
    // signed feature hashing to reduce collisions cancelling constructively
    v[hu % dim] += ((hu >>> 24) & 1) ? 1 : -1;
    if (i + 1 < toks.length) {
      const bi = uni + '' + toks[i + 1];
      const hb = fnv1a(bi);
      v[hb % dim] += ((hb >>> 24) & 1) ? 1 : -1;
    }
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/** Batch embed. Returns Float32Array[]. */
export function embedBatch(texts, dim = 256) {
  return texts.map((t) => embedText(t, dim));
}

/** Cosine similarity between two equal-length numeric vectors (dot, since both are unit-norm). */
export function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / den;
}

/**
 * Rough token count for context-budget accounting. Whitespace words ≈ 0.75 tokens each is a
 * common heuristic; we use chars/4 which is the standard OpenAI-ish approximation and is
 * sufficient for the Compression (Cr) telemetry (a RATIO of the same estimator on both arms).
 */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export const DEFAULT_DIM = 256;
