import type { BenchScore, BenchScoreInput } from './types.js';
/**
 * Score a single benchmark result per ADR-076.
 *
 * `verifiedSolve` is the conjunction of public ∧ hidden ∧ regression ∧ safety
 * (zero safety violations AND zero blocked-file touches). It dominates the base
 * score at 0.40, so the only way to earn the bulk of the score is a clean,
 * bounded, non-regressing solve. The penalty layer then subtracts for safety
 * violations, blocked-file touches, regression failure, hallucinated file
 * references, and excessive cost — any of which can drive finalScore negative.
 *
 * @param input pure, I/O-free inputs (booleans + metered cost/latency).
 * @returns a fully-rounded, deterministic BenchScore.
 */
export declare function scoreBenchmark(input: BenchScoreInput): BenchScore;
//# sourceMappingURL=score.d.ts.map