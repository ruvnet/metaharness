// SPDX-License-Identifier: MIT
//
// Numeric-genome mutation + crossover (ADR-272). Deterministic, seeded,
// dependency-free — no `Math.random`, mirroring the prompt-kind
// `DeterministicMutator` (mutator.ts)'s reproducibility contract. Perturbation
// is bounded Gaussian noise scaled to each parameter's declared span, respecting
// `linear`/`log` scale and `float`/`int` type, always clamped to `[min, max]`.
/** A pure 32-bit hash — seeds the PRNG without `Math.random` (mirrors mutator.ts's `hash`). */
function hash(...parts) {
    let h = 0x811c9dc5;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** mulberry32: a small, fast, deterministic PRNG. Returns a fresh `() => [0,1)` generator. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Standard normal sample via Box–Muller, driven by a deterministic `[0,1)` source. */
function gaussian(rand) {
    let u = 0;
    let v = 0;
    while (u === 0)
        u = rand();
    while (v === 0)
        v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function toUnit(value, spec) {
    if (spec.scale === 'log') {
        const lo = Math.log(Math.max(spec.min, Number.EPSILON));
        const hi = Math.log(Math.max(spec.max, Number.EPSILON));
        return (Math.log(Math.max(value, Number.EPSILON)) - lo) / Math.max(hi - lo, Number.EPSILON);
    }
    return (value - spec.min) / Math.max(spec.max - spec.min, Number.EPSILON);
}
function fromUnit(unit, spec) {
    const clampedUnit = Math.min(1, Math.max(0, unit));
    let value;
    if (spec.scale === 'log') {
        const lo = Math.log(Math.max(spec.min, Number.EPSILON));
        const hi = Math.log(Math.max(spec.max, Number.EPSILON));
        value = Math.exp(lo + clampedUnit * (hi - lo));
    }
    else {
        value = spec.min + clampedUnit * (spec.max - spec.min);
    }
    value = Math.min(spec.max, Math.max(spec.min, value));
    return spec.type === 'int' ? Math.round(value) : value;
}
/** Each parameter's bounds midpoint (or explicit `default`) — the baseline genome. */
export function defaultGenome(genomeSpec) {
    const out = {};
    for (const [name, spec] of Object.entries(genomeSpec)) {
        if (spec.default !== undefined) {
            out[name] = spec.type === 'int' ? Math.round(spec.default) : spec.default;
            continue;
        }
        out[name] = fromUnit(0.5, spec);
    }
    return out;
}
/**
 * Perturb every parameter of `parent` by independent bounded Gaussian noise
 * (in unit-interval space, so `log`-scale parameters like a learning rate are
 * perturbed multiplicatively, not additively) and return the mutated genome
 * plus which parameters actually changed value. `sigma` is the noise stddev as
 * a fraction of each parameter's unit span (e.g. 0.2 = 20%).
 */
export function mutateGenome(parent, genomeSpec, seed, generation, index, sigma) {
    const rand = mulberry32(hash(seed, generation, index, 'numeric-mutate'));
    const out = {};
    const mutatedParams = [];
    for (const [name, spec] of Object.entries(genomeSpec)) {
        const current = parent[name] ?? fromUnit(0.5, spec);
        const unit = toUnit(current, spec);
        const noisy = unit + gaussian(rand) * sigma;
        const next = fromUnit(noisy, spec);
        out[name] = next;
        if (next !== current)
            mutatedParams.push(name);
    }
    // Every candidate must differ from its parent by at least one parameter, or
    // the archive fills with indistinguishable duplicates. If bounded rounding
    // happened to produce a no-op genome, force one deterministically-chosen
    // parameter a full sigma (min 0.05 of its unit span) away from the parent.
    if (mutatedParams.length === 0) {
        const names = Object.keys(genomeSpec);
        if (names.length > 0) {
            const name = names[hash(seed, generation, index, 'numeric-forced') % names.length];
            const spec = genomeSpec[name];
            const current = parent[name] ?? fromUnit(0.5, spec);
            const unit = toUnit(current, spec);
            const forced = fromUnit(Math.min(1, Math.max(0, unit + (rand() < 0.5 ? -1 : 1) * Math.max(sigma, 0.05))), spec);
            if (forced !== current) {
                out[name] = forced;
                mutatedParams.push(name);
            }
        }
    }
    return { genome: out, mutatedParams };
}
/**
 * Uniform crossover (ADR-272, mirrors ADR-089's surface crossover): each
 * parameter is independently inherited from `parentA` or `parentB`, chosen by
 * a deterministic coin flip. Always adopts a proper, non-empty subset from B
 * (never all-A, never all-B) so the child is genuinely a recombination.
 */
export function crossoverGenome(parentA, parentB, genomeSpec, seed, generation, index) {
    const names = Object.keys(genomeSpec);
    const rand = mulberry32(hash(seed, generation, index, 'numeric-crossover'));
    let fromB = names.filter(() => rand() < 0.5);
    if (fromB.length === 0 && names.length > 0)
        fromB = [names[hash(seed, generation, index) % names.length]];
    if (fromB.length === names.length && names.length > 1)
        fromB = fromB.slice(0, -1);
    const out = { ...parentA };
    for (const name of fromB) {
        if (parentB[name] !== undefined)
            out[name] = parentB[name];
    }
    return { genome: out, fromB };
}
/** Build a `NumericVariant` from a mutation result. */
export function makeVariant(parent, generation, index, genome, mutatedParams, summary) {
    const id = parent === null ? 'baseline' : `g${generation}_v${index}`;
    return {
        id,
        parentId: parent?.id ?? null,
        generation,
        genome,
        mutatedParams,
        mutationSummary: summary,
        createdAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=numeric-mutator.js.map