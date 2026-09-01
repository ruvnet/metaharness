/**
 * mulberry32 — a tiny, fast, deterministic 32-bit PRNG (mirrors bench/stats.ts).
 * Seeding it makes population sampling, mutation choice, and bootstrap statistics
 * reproducible. Returns a stateful generator producing floats in [0, 1).
 */
export declare function makeRng(seed: number): () => number;
/**
 * Round to 6 decimal places. Kills float-representation noise so scores and
 * receipts are byte-identical across runs (ADR-155 reproducibility). The leading
 * `+` drops any `-0`.
 */
export declare function round6(value: number): number;
/** Deterministic 32-bit FNV-1a hash of a string. The embedding seed. */
export declare function fnv1a(text: string): number;
/**
 * A deterministic, dependency-free "embedding": a fixed-dimension unit vector
 * derived from a string's tokens. This is NOT a learned model — it is a
 * reproducible stand-in for ruVector's embedder (ADR-074/155) that gives stable
 * cosine similarities for the retrieval tests, with no network and no weights.
 * Token-bag hashing means semantically-overlapping text shares dimensions, so
 * similar code/queries score higher — enough to exercise the ranking math.
 */
export declare function embed(text: string, dim?: number): number[];
/** L2-normalise a vector to a unit vector (zero vector stays zero). */
export declare function normalize(v: number[]): number[];
/** Cosine similarity of two equal-length vectors, clamped to [0,1] for ranking. */
export declare function cosine(a: number[], b: number[]): number;
/** Clamp `x` into [lo, hi]. */
export declare function clamp(x: number, lo: number, hi: number): number;
//# sourceMappingURL=util.d.ts.map