import type { RunMetrics } from './types.js';
/**
 * Shared evaluation budgets for the fitness cost/latency terms. Centralized so
 * the evolution loop and the benchmark grade on the IDENTICAL scale (a mismatch
 * would make a champion look better than it benchmarks). The cost budget is set
 * tight enough that over-provisioning (e.g. a 5th reviewer that adds no detection
 * or FP benefit on the corpus) is strictly penalized, so evolution converges to
 * the LEAN optimum and the champion stays comfortably under the 2×-cost gate.
 */
export declare const COST_BUDGET = 20;
export declare const TIME_BUDGET = 5;
/** Inputs to the per-finding operational score. */
export interface FindingScoreInput {
    confirmedRepro: boolean;
    patchPassesTests: boolean;
    /** ≥2 static tools agreed. */
    staticToolAgreement: boolean;
    /** 0..1 novelty (1 = unseen in memory). */
    novelty: number;
    /** 0..1 maintainer acceptance signal. */
    maintainerAcceptance: number;
    falsePositive: boolean;
    unsafeOutput: boolean;
}
/** The frozen per-finding score (ADR-155 §scoring). Can go strongly negative. */
export declare function findingScore(x: FindingScoreInput): number;
/** Inputs to the genome-level fitness (relative to a fixed-harness baseline). */
export interface FitnessInput {
    metrics: RunMetrics;
    /** Ground-truth vulnerable sites across the corpus (denominator for TPR). */
    groundTruthCount: number;
    /** Total decoys across the corpus (denominator for FP rate). */
    decoyCount: number;
    /** The baseline harness false-positive RATE, for the reduction term. */
    baselineFalsePositiveRate: number;
    /** Cost budget for the cost-efficiency term (deterministic proxy). */
    costBudget: number;
    /** Time budget for the time-to-finding term (deterministic proxy). */
    timeBudget: number;
}
/** Derived, human-readable metric bundle used by the benchmark report. */
export interface FitnessBreakdown {
    truePositiveRate: number;
    falsePositiveRate: number;
    patchTestPassRate: number;
    reproductionSuccess: number;
    falsePositiveReduction: number;
    timeToFindingScore: number;
    costEfficiency: number;
    unsafeOutputs: number;
    fitness: number;
}
/** The frozen genome-level fitness (ADR-155 §evaluation framework). */
export declare function fitness(x: FitnessInput): FitnessBreakdown;
//# sourceMappingURL=scoring.d.ts.map