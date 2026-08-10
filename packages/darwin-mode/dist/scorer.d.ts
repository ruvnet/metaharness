import type { RunTrace, ScoreCard } from './types.js';
/**
 * Opt-in deterministic signals for scoreVariant (ADR-249). Both fields are
 * optional; each absent field leaves the corresponding term byte-identical to
 * the pre-seam behaviour. Structural on purpose: upstream producers (e.g. an
 * aggregate over @metaharness/turn-credit `creditByLabel`) are NOT imported —
 * darwin-mode stays dependency-free phase-1 and accepts plain numbers.
 */
export interface ScoreSignals {
    /**
     * Injected trace-quality signal in [0,1]. When present and finite it
     * replaces the binary size heuristic (clamped to [0,1], round6'd); when
     * absent or non-finite the heuristic runs unchanged.
     */
    traceQuality?: number;
    /**
     * Deterministic cost input in abstract cost-units (NOT wall-clock — tokens,
     * tool calls, cost-proxy seconds… anything the caller derives reproducibly).
     * costEfficiency = 1.0 at/under budget, else budgetUnits/units (monotone
     * non-increasing in units, round6'd). Ignored unless both fields are finite
     * and positive-budget.
     */
    cost?: {
        units: number;
        budgetUnits: number;
    };
}
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
 * @param signals        opt-in deterministic signal seams (ADR-249); omit for
 *                       byte-identical pre-seam behaviour
 */
export declare function scoreVariant(variantId: string, traces: RunTrace[], parentScore: ScoreCard | null, promotionDelta: number, taskTimeoutMs?: number, signals?: ScoreSignals): ScoreCard;
//# sourceMappingURL=scorer.d.ts.map