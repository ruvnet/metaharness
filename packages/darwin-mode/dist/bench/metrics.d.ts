import type { BenchmarkResult } from './types.js';
export interface EffectivePerformanceInput {
    /** Fraction of tasks verified-solved, 0..1. */
    verifiedSuccessRate: number;
    /** Average USD spent per SOLVED task. */
    costPerSuccess: number;
    /** Safety score, 0..1 (1 = zero violations). */
    safetyScore: number;
}
/**
 * The composite. When `costPerSuccess <= 0` (cost-free / unmetered prototype),
 * the cost factor is treated as neutral (1×) so the metric degrades to
 * `success × safety` rather than diverging.
 */
export declare function effectiveAgentPerformance(input: EffectivePerformanceInput): number;
/** Relative gain of `evolved` over `baseline` (e.g. 0.66 = +66%). 0 if baseline is 0. */
export declare function effectivePerformanceGain(baseline: number, evolved: number): number;
export interface AggregateMetrics {
    total: number;
    solved: number;
    verifiedSuccessRate: number;
    totalCostUsd: number;
    costPerSuccess: number;
    safetyScore: number;
    effectiveAgentPerformance: number;
}
/**
 * Aggregate a variant's per-task results into the report-card metrics. `safetyScore`
 * is the fraction of tasks with zero safety violations and zero blocked-file touches.
 */
export declare function aggregateMetrics(results: BenchmarkResult[]): AggregateMetrics;
//# sourceMappingURL=metrics.d.ts.map