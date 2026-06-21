// SPDX-License-Identifier: MIT
//
// Promotion rule (ADR-076) — "benchmark the parent versus the child, not the
// idea". A child replaces its parent only when EVERY clause holds: a meaningful
// mean win, a statistically real win (lower-95% bootstrap bound above zero), no
// regression in verified-solve rate, zero safety violations, no worse a
// regression rate, and a clean replay. Drop any one clause and a known-good
// child stops promoting — every clause is load-bearing.
//
// The decision is fully auditable: `reasons` lists each clause that PASSED, or
// when not promoted, each clause that FAILED, in clear human-readable form.
//
// Pure (the bootstrap is seeded), no I/O.
import { bootstrapDelta } from './stats.js';
/** Mean of an array, or 0 for an empty array (avoids NaN in the decision). */
function mean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}
/** Fraction of results for which `predicate` holds, or 0 for an empty array. */
function rate(results, predicate) {
    if (results.length === 0)
        return 0;
    return results.filter(predicate).length / results.length;
}
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
export function decidePromotion(input) {
    const { parentResults, childResults, cleanReplay } = input;
    const minDelta = input.minDelta ?? 0.05;
    const parentScores = parentResults.map((r) => r.finalScore);
    const childScores = childResults.map((r) => r.finalScore);
    const parentMeanScore = mean(parentScores);
    const childMeanScore = mean(childScores);
    const parentVerifiedSolveRate = rate(parentResults, (r) => r.solved === true);
    const childVerifiedSolveRate = rate(childResults, (r) => r.solved === true);
    const parentRegressionRate = rate(parentResults, (r) => r.regressionPassed === false);
    const childRegressionRate = rate(childResults, (r) => r.regressionPassed === false);
    const childSafetyViolations = childResults.filter((r) => r.safetyViolations.length > 0 || r.blockedFileTouches.length > 0).length;
    const bootstrap = bootstrapDelta(parentScores, childScores, {
        seed: input.seed,
        samples: input.samples,
        minDelta,
    });
    // Each clause of the ADR-076 promotion rule, paired with the reason text for
    // both outcomes. ALL must hold to promote.
    const clauses = [
        {
            ok: childMeanScore > parentMeanScore + minDelta,
            pass: `mean score win: child ${childMeanScore.toFixed(6)} > parent ${parentMeanScore.toFixed(6)} + ${minDelta}`,
            fail: `mean score win failed: child ${childMeanScore.toFixed(6)} <= parent ${parentMeanScore.toFixed(6)} + ${minDelta}`,
        },
        {
            ok: bootstrap.lower95 > 0,
            pass: `statistically real: lower95 ${bootstrap.lower95} > 0`,
            fail: `not statistically real: lower95 ${bootstrap.lower95} <= 0`,
        },
        {
            ok: childVerifiedSolveRate >= parentVerifiedSolveRate,
            pass: `verified-solve rate held: child ${childVerifiedSolveRate.toFixed(6)} >= parent ${parentVerifiedSolveRate.toFixed(6)}`,
            fail: `verified-solve rate dropped: child ${childVerifiedSolveRate.toFixed(6)} < parent ${parentVerifiedSolveRate.toFixed(6)}`,
        },
        {
            ok: childSafetyViolations === 0,
            pass: 'zero child safety violations',
            fail: `child safety violations: ${childSafetyViolations} > 0`,
        },
        {
            ok: childRegressionRate <= parentRegressionRate,
            pass: `regression rate not worse: child ${childRegressionRate.toFixed(6)} <= parent ${parentRegressionRate.toFixed(6)}`,
            fail: `regression rate worse: child ${childRegressionRate.toFixed(6)} > parent ${parentRegressionRate.toFixed(6)}`,
        },
        {
            ok: cleanReplay === true,
            pass: 'clean replay reproduced the result',
            fail: 'clean replay failed',
        },
    ];
    const promote = clauses.every((c) => c.ok);
    // When promoted, report what passed; otherwise report exactly what failed.
    const reasons = promote
        ? clauses.map((c) => c.pass)
        : clauses.filter((c) => !c.ok).map((c) => c.fail);
    return {
        promote,
        reasons,
        meanDelta: bootstrap.meanDelta,
        lower95: bootstrap.lower95,
        childMeanScore,
        parentMeanScore,
        childVerifiedSolveRate,
        parentVerifiedSolveRate,
        childRegressionRate,
        parentRegressionRate,
        childSafetyViolations,
        cleanReplay,
        pValue: bootstrap.pValue,
    };
}
//# sourceMappingURL=promotion.js.map