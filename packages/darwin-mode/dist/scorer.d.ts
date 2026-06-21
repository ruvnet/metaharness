import type { RunTrace, ScoreCard } from './types.js';
/**
 * The authoritative scoring weights (ADR-072 §base score). They sum to 1.0 and
 * are exposed so callers (and the archive) can report the policy in force.
 */
export declare function scoreWeights(): {
    taskSuccess: number;
    testPassRate: number;
    traceQuality: number;
    costEfficiency: number;
    latencyEfficiency: number;
    safetyScore: number;
};
/**
 * Score a variant from its run traces, fold in the penalty layer, and decide
 * promotion against the parent. `parentScore` is null for the baseline (which
 * is graded against a zero floor and never promoted).
 *
 * @param variantId      the variant being scored
 * @param traces         one trace per task this variant ran
 * @param parentScore    the parent's scorecard, or null for the baseline
 * @param promotionDelta anti-noise margin a child must beat the parent by
 * @param taskTimeoutMs  wall-clock budget used to normalise latency
 */
export declare function scoreVariant(variantId: string, traces: RunTrace[], parentScore: ScoreCard | null, promotionDelta: number, taskTimeoutMs?: number): ScoreCard;
//# sourceMappingURL=scorer.d.ts.map