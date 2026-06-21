// SPDX-License-Identifier: MIT
//
// Seeded bootstrap statistics (ADR-076) — the anti-noise guard on promotion.
// A child is only "really" better than its parent when the lower 95% bound on
// the bootstrapped parent→child score delta is above zero, not one lucky run.
//
// CRITICAL: the bootstrap MUST be reproducible. The reference design used
// `Math.random()`, which is non-deterministic and would itself fail the Repro
// gate (ADR-076 §statistical promotion). This module uses a SEEDED mulberry32
// PRNG, so the verdict is byte-reproducible from a clean checkout: the same
// (scores, seed) always yields the identical lower95/meanDelta.
//
// Pure (the RNG is seeded), no I/O.
/**
 * mulberry32 — a tiny, fast, deterministic 32-bit PRNG. Returns a stateful
 * generator producing floats in [0, 1). Seeding it makes the whole bootstrap
 * reproducible, which is the entire point: re-running from a clean checkout
 * yields the identical promotion verdict (ADR-076 Repro gate).
 */
export function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * Round to 6 decimal places. Kills float-representation noise so the bootstrap
 * output is byte-identical across runs and clean in JSON artifacts. The leading
 * `+` drops any `-0`. Re-implemented locally to keep this module dependency-free.
 */
function round6(value) {
    return +(Math.round(value * 1e6) / 1e6).toFixed(6);
}
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
export function bootstrapDelta(parentScores, childScores, opts) {
    const samples = opts?.samples ?? 5000;
    const seed = opts?.seed ?? 0;
    const minDelta = opts?.minDelta ?? 0.05;
    if (parentScores.length === 0 || childScores.length === 0) {
        return { meanDelta: 0, lower95: 0, upper95: 0, promote: false, samples, pValue: 1 };
    }
    const rng = makeRng(seed);
    const deltas = new Array(samples);
    let sum = 0;
    let nonPositive = 0;
    for (let i = 0; i < samples; i += 1) {
        const parent = parentScores[Math.floor(rng() * parentScores.length)];
        const child = childScores[Math.floor(rng() * childScores.length)];
        const delta = child - parent;
        deltas[i] = delta;
        sum += delta;
        if (delta <= 0)
            nonPositive += 1;
    }
    deltas.sort((x, y) => x - y);
    const meanDelta = round6(sum / samples);
    const lower95 = round6(deltas[Math.floor(samples * 0.025)]);
    const upper95 = round6(deltas[Math.floor(samples * 0.975)]);
    const promote = meanDelta > minDelta && lower95 > 0;
    // One-sided bootstrap p-value for H0: delta ≤ 0 (the share of resamples ≤ 0).
    const pValue = round6(nonPositive / samples);
    return { meanDelta, lower95, upper95, promote, samples, pValue };
}
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
export function benjaminiHochberg(pValues, q) {
    const m = pValues.length;
    const result = new Array(m).fill(false);
    if (m === 0 || q <= 0)
        return result;
    const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
    let cutoff = -1; // largest p that passes the BH threshold
    for (let rank = 1; rank <= m; rank += 1) {
        if (order[rank - 1].p <= (rank / m) * q)
            cutoff = order[rank - 1].p;
    }
    if (cutoff < 0)
        return result;
    for (let j = 0; j < m; j += 1)
        if (pValues[j] <= cutoff)
            result[j] = true;
    return result;
}
//# sourceMappingURL=stats.js.map