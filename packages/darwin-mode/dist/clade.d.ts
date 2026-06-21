import type { Archive } from './archive.js';
import type { HarnessVariant } from './types.js';
/** mulberry32 — a tiny, fast, deterministic PRNG seeded from a 32-bit integer. */
export declare function mulberry32(seed: number): () => number;
/** Beta(a, b) = X/(X+Y), X~Gamma(a), Y~Gamma(b). Deterministic given `rng`. */
export declare function sampleBeta(rng: () => number, a: number, b: number): number;
/**
 * Clade outcome counts over a variant's descendant subtree (inclusive). A scored
 * node is a "success" iff it was promoted, else a "failure"; unscored nodes are
 * ignored. Cycle-guarded. O(subtree).
 */
export declare function cladeOutcomes(archive: Archive, rootId: string): {
    passes: number;
    failures: number;
};
/**
 * Clade-metaproductivity Thompson selection: for every scored variant draw
 * `u ~ Beta(τ·passes+1, τ·failures+1)` over its subtree outcomes and return the
 * top-`limit` variants by `u`. Seeded → reproducible. Returns `[]` when nothing
 * is scored (caller falls back).
 *
 * @param tau exploration→exploitation schedule in [0, ∞): 0 ⇒ uniform Beta(1,1)
 *   (pure exploration); larger ⇒ sharper posteriors (exploitation).
 */
export declare function cladeThompsonSelect(archive: Archive, tau: number, limit: number, seed: number): HarnessVariant[];
//# sourceMappingURL=clade.d.ts.map