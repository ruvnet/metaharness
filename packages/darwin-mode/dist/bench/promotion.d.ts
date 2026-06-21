import type { BenchmarkResult, PromotionDecision } from './types.js';
/**
 * Decide whether a child variant should be promoted over its parent (ADR-076).
 *
 * Aggregates the per-task `BenchmarkResult`s of parent and child into the
 * statistics the promotion rule needs, runs the seeded bootstrap over the
 * score deltas, then applies all six promotion clauses. Returns the full,
 * auditable `PromotionDecision` with the bootstrap's `meanDelta`/`lower95` and
 * a human-readable reason per clause.
 *
 * Deterministic: a fixed `seed` yields an identical decision.
 */
export declare function decidePromotion(input: {
    parentResults: BenchmarkResult[];
    childResults: BenchmarkResult[];
    cleanReplay: boolean;
    minDelta?: number;
    seed?: number;
    samples?: number;
}): PromotionDecision;
//# sourceMappingURL=promotion.d.ts.map