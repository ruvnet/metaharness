import type { BootstrapResult } from './types.js';
/**
 * mulberry32 — a tiny, fast, deterministic 32-bit PRNG. Returns a stateful
 * generator producing floats in [0, 1). Seeding it makes the whole bootstrap
 * reproducible, which is the entire point: re-running from a clean checkout
 * yields the identical promotion verdict (ADR-076 Repro gate).
 */
export declare function makeRng(seed: number): () => number;
/**
 * Seeded bootstrap over the parent→child per-task score deltas.
 *
 * Draws `samples` independent bootstrap deltas: each iteration picks one parent
 * score and one child score uniformly at random (from the seeded PRNG) and
 * records `child - parent`. The sorted deltas give the mean and the 2.5%/97.5%
 * percentiles. `promote` requires both a meaningful mean (> `minDelta`) and a
 * lower-95% bound above zero (the win is statistically real).
 *
 * Empty parent or child arrays yield a safe zero result (nothing to promote).
 * Pure and deterministic for a fixed `seed`.
 */
export declare function bootstrapDelta(parentScores: number[], childScores: number[], opts?: {
    samples?: number;
    seed?: number;
    minDelta?: number;
}): BootstrapResult;
/**
 * Benjamini–Hochberg false-discovery-rate control (ADR-096). Given a set of
 * one-sided p-values and a target FDR `q`, return a boolean per hypothesis:
 * `true` ⇒ rejected H0 (i.e. a statistically real discovery after correcting
 * for multiple testing). Standard step-up: sort ascending, find the largest k
 * with p_(k) ≤ (k/m)·q, reject all hypotheses with p ≤ that threshold. Pure and
 * deterministic. Empty input ⇒ empty output; q ≤ 0 ⇒ reject nothing.
 *
 * CALIBRATION (ADR-112): BH controls FDR only when the input p-values are
 * (super-)uniform under the null. Bootstrap p-values from `bootstrapDelta` meet
 * this from ~5 samples up; at n=3 they are too coarse/anti-conservative and the
 * empirical FDR is ~33% at q=0.05. Callers must supply ≥ 5 task-scores per variant.
 */
export declare function benjaminiHochberg(pValues: readonly number[], q: number): boolean[];
//# sourceMappingURL=stats.d.ts.map