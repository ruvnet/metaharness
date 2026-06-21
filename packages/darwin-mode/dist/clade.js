// SPDX-License-Identifier: MIT
//
// Clade-metaproductivity parent selection (ADR-094), after the Huxley-Gödel
// Machine (Wang, Piękos, Li et al., arXiv:2510.21614, 2025). It fixes the
// "metaproductivity–performance mismatch": the best-SCORING variant is a poor
// PARENT because it has exhausted its descendant diversity. HGM instead selects
// parents by Clade Metaproductivity — the success rate of a variant's whole
// descendant subtree — via Thompson sampling over Beta(τ·passes+1, τ·fails+1),
// with τ scheduling exploration→exploitation.
//
// We tie τ to the SGM risk budget (ADR-090): early (budget full) → low τ → flat
// Betas → exploration; late (budget spent) → high τ → sharp Betas → exploitation.
//
// Unlike the paper (which uses Math.random), the Beta draws here come from a
// SEEDED PRNG, so clade selection is fully reproducible (ADR-075) — same seed ⇒
// same parents. Dependency-free.
/** mulberry32 — a tiny, fast, deterministic PRNG seeded from a 32-bit integer. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Standard normal via Box–Muller from a uniform stream. */
function sampleNormal(rng) {
    let u = 0, v = 0;
    while (u === 0)
        u = rng();
    while (v === 0)
        v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Gamma(shape ≥ 1, scale 1) via Marsaglia–Tsang. Our shapes are always ≥ 1. */
function sampleGamma(rng, shape) {
    const k = Math.max(1, shape);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
        const x = sampleNormal(rng);
        const v0 = 1 + c * x;
        if (v0 <= 0)
            continue;
        const v = v0 * v0 * v0;
        const u = rng();
        if (u < 1 - 0.0331 * x * x * x * x)
            return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
            return d * v;
    }
}
/** Beta(a, b) = X/(X+Y), X~Gamma(a), Y~Gamma(b). Deterministic given `rng`. */
export function sampleBeta(rng, a, b) {
    const x = sampleGamma(rng, a);
    const y = sampleGamma(rng, b);
    return x + y === 0 ? 0.5 : x / (x + y);
}
/**
 * Clade outcome counts over a variant's descendant subtree (inclusive). A scored
 * node is a "success" iff it was promoted, else a "failure"; unscored nodes are
 * ignored. Cycle-guarded. O(subtree).
 */
export function cladeOutcomes(archive, rootId) {
    let passes = 0, failures = 0;
    const seen = new Set();
    const stack = [rootId];
    while (stack.length > 0) {
        const id = stack.pop();
        if (seen.has(id))
            continue;
        seen.add(id);
        const rec = archive.get(id);
        if (!rec)
            continue;
        if (rec.score !== null) {
            if (rec.score.promoted)
                passes += 1;
            else
                failures += 1;
        }
        for (const child of rec.children)
            stack.push(child);
    }
    return { passes, failures };
}
/**
 * Clade-metaproductivity Thompson selection: for every scored variant draw
 * `u ~ Beta(τ·passes+1, τ·failures+1)` over its subtree outcomes and return the
 * top-`limit` variants by `u`. Seeded → reproducible. Returns `[]` when nothing
 * is scored (caller falls back).
 *
 * @param tau exploration→exploitation schedule in [0, ∞): 0 ⇒ uniform Beta(1,1)
 *   (pure exploration); larger ⇒ sharper posteriors (exploitation).
 */
export function cladeThompsonSelect(archive, tau, limit, seed) {
    if (limit <= 0)
        return [];
    const rng = mulberry32(seed);
    const t = Math.max(0, tau);
    const scored = archive.all().filter((r) => r.score !== null);
    if (scored.length === 0)
        return [];
    const ranked = scored
        .map((r) => {
        const { passes, failures } = cladeOutcomes(archive, r.variant.id);
        const u = sampleBeta(rng, t * passes + 1, t * failures + 1);
        return { variant: r.variant, u };
    })
        .sort((a, b) => b.u - a.u);
    return ranked.slice(0, limit).map((x) => x.variant);
}
//# sourceMappingURL=clade.js.map