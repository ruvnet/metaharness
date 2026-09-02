import type { Corpus } from './corpus.js';
import type { HarnessGenome } from './types.js';
/** Per-repo fitness samples for a genome — the distribution the gate uses. */
export declare function perRepoFitness(genome: HarnessGenome, corpus: Corpus, baselineFalsePositiveRate: number): number[];
export interface BootstrapResult {
    meanDelta: number;
    lower95: number;
    upper95: number;
    /** meanDelta > minDelta ∧ lower95 > 0. */
    promote: boolean;
    samples: number;
    /** One-sided bootstrap p-value for H0: delta ≤ 0. */
    pValue: number;
}
/**
 * Seeded bootstrap over the previous→new per-repo score deltas. PAIRED by repo:
 * each repo is a matched unit (same code, same difficulty), so the correct
 * statistic is the per-repo delta `new[i] − prev[i]`, resampled with replacement
 * over repos. This controls for repo difficulty — an unpaired (cross-product)
 * bootstrap would spuriously compare the champion's hardest repo against the
 * baseline's easiest. Falls back to the unpaired estimator when the two arrays
 * are not aligned (different lengths). Draws `samples` resampled mean-deltas;
 * `promote` requires a meaningful mean AND a lower-95% bound above zero.
 */
export declare function bootstrapDelta(prevScores: number[], newScores: number[], opts?: {
    samples?: number;
    seed?: number;
    minDelta?: number;
}): BootstrapResult;
export interface PromotionDecision {
    promote: boolean;
    reasons: string[];
    meanDelta: number;
    lower95: number;
    newMeanFitness: number;
    prevMeanFitness: number;
    /** New harness must not regress on safety (zero unsafe across repos). */
    unsafeRegression: boolean;
    pValue: number;
}
/**
 * The full champion-vs-(previous champion | baseline) promotion verdict
 * (ADR-155 addendum). The new harness is admitted only when it is statistically
 * superior (lower-95% delta > 0) AND introduces no unsafe-output regression.
 */
export declare function decidePromotion(prevGenome: HarnessGenome, newGenome: HarnessGenome, corpus: Corpus, baselineFalsePositiveRate: number, opts?: {
    samples?: number;
    seed?: number;
    minDelta?: number;
}): PromotionDecision;
//# sourceMappingURL=stats.d.ts.map