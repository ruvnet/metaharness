// SPDX-License-Identifier: MIT
//
// A `NumericSurrogate` backed by `ruv-fann` (Rust/WASM dense networks).
//
// `ruv-fann` is an OPTIONAL peer, never a hard dependency: this package stays
// dependency-free unless a caller asks for this surrogate. It is loaded lazily
// through an indirect specifier, and `createFannSurrogate` rejects with a clear
// message when it is absent. `ruv-fann` is ESM-only and needs Node >= 20.9.
//
// The model is a small `inputs → hidden… → 1 (Linear)` regressor (one Tanh
// hidden layer of 8 by default; shape, activation, optimizer, ensembling and an
// exploration bonus are all configurable — see `FannSurrogateOptions`), refit
// from a fixed seeded initialisation on every `fit`, so the same rows always
// yield the same weights. (Measured on ruv-fann 0.1.2: repeated runs and the
// SIMD / non-SIMD backends produce bit-identical weights and predictions.)
const PREDICT_BATCH = 256;
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
function initialModel(inputs, hidden, activation, steepness, seed) {
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const layer = (i, o, act, steep) => {
        const limit = Math.sqrt(6 / (i + o)); // Glorot-uniform
        return {
            inputs: i,
            outputs: o,
            weights: Array.from({ length: i * o }, () => (rand() * 2 - 1) * limit),
            bias: new Array(o).fill(0),
            activation: act,
            steepness: steep,
        };
    };
    const layers = [];
    let width = inputs;
    for (const h of hidden) {
        layers.push(layer(width, h, activation, steepness));
        width = h;
    }
    layers.push(layer(width, 1, 'Linear', 1));
    return { schema: 'ruv-fann.dense-layers/1', layers };
}
/**
 * Largest epoch count ruv-fann will accept for this shape. Mirrors its
 * published bound: backward·(epochs+1) + update·epochs ≤ maxTrainingWork.
 */
export function fannEpochBudget(rows, inputs, hidden, maxTrainingWork) {
    let parameters = 0;
    let width = inputs;
    for (const h of [...(typeof hidden === 'number' ? [hidden] : hidden), 1]) {
        parameters += width * h + h;
        width = h;
    }
    const backward = rows * (32 * parameters + 8 * (inputs + 1) + 1);
    const update = 64 * parameters;
    return Math.floor((maxTrainingWork - backward) / (backward + update));
}
export class FannSurrogate {
    runtime;
    limits;
    options;
    /** The most recent successful fit, or null. */
    lastFit = null;
    prepared = [];
    hidden;
    members;
    mean = 0; // of the (possibly rank-transformed) targets
    scale = 1;
    inputs = 0;
    constructor(runtime, limits, options = {}) {
        this.runtime = runtime;
        this.limits = limits;
        this.options = options;
        const hidden = options.hidden ?? 8;
        this.hidden = typeof hidden === 'number' ? [hidden] : [...hidden];
        if (this.hidden.length === 0 || this.hidden.some((h) => !Number.isInteger(h) || h < 1)) {
            throw new RangeError('FannSurrogate: hidden must be a positive integer or a non-empty list of them');
        }
        this.members = options.ensemble ?? 1;
        if (!Number.isInteger(this.members) || this.members < 1 || this.members > 16) {
            throw new RangeError('FannSurrogate: ensemble must be an integer from 1 to 16');
        }
        if (options.explorationWeight !== undefined && !Number.isFinite(options.explorationWeight)) {
            throw new RangeError('FannSurrogate: explorationWeight must be finite');
        }
        for (const [name, value] of [['epochs', options.epochs], ['learningRate', options.learningRate], ['steepness', options.steepness], ['maxRows', options.maxRows]]) {
            if (value !== undefined && !(value > 0))
                throw new RangeError(`FannSurrogate: ${name} must be positive`);
        }
    }
    async fit(allRows) {
        const maxRows = Math.min(this.options.maxRows ?? 256, this.limits.maxRows);
        const rows = allRows.slice(-maxRows);
        const inputs = rows[0]?.features.length ?? 0;
        if (rows.length < 2 || inputs === 0)
            return false;
        // Scale targets so one learning rate suits any `primary` scale.
        let targets = rows.map((r) => r.target);
        const rankMode = this.options.targetTransform === 'rank';
        if (rankMode) {
            const order = targets.map((_, i) => i).sort((p, q) => targets[p] - targets[q] || p - q);
            const ranked = new Array(targets.length);
            for (let i = 0; i < order.length;) {
                let j = i;
                while (j + 1 < order.length && targets[order[j + 1]] === targets[order[i]])
                    j++;
                for (let k = i; k <= j; k++)
                    ranked[order[k]] = (i + j) / 2 / (targets.length - 1);
                i = j + 1;
            }
            targets = ranked;
        }
        let mean = 0;
        for (const t of targets)
            mean += t;
        mean /= targets.length;
        let variance = 0;
        for (const t of targets)
            variance += (t - mean) ** 2;
        const scale = Math.sqrt(variance / targets.length);
        if (!(scale > 0) || !Number.isFinite(scale))
            return false; // constant targets: nothing to rank by
        const epochs = Math.min(Math.floor(this.options.epochs ?? 300), fannEpochBudget(rows.length, inputs, this.hidden, this.limits.maxTrainingWork));
        if (epochs < 1)
            return false;
        const x = new Float64Array(rows.length * inputs);
        const y = new Float64Array(rows.length);
        rows.forEach((r, i) => {
            if (r.features.length !== inputs)
                throw new Error('FannSurrogate.fit: rows have inconsistent feature lengths');
            x.set(r.features, i * inputs);
            y[i] = (targets[i] - mean) / scale;
        });
        const next = [];
        let initialLoss = 0;
        let finalLoss = 0;
        try {
            for (let m = 0; m < this.members; m++) {
                const model = initialModel(inputs, this.hidden, this.options.activation ?? 'Tanh', this.options.steepness ?? 1, (this.options.seed ?? 0) + m);
                const result = this.runtime.train(model, {
                    inputs: x,
                    targets: y,
                    rows: rows.length,
                    epochs,
                    learningRate: this.options.learningRate ?? 0.03,
                    optimizer: this.options.optimizer ?? 'adamw',
                });
                if (!Number.isFinite(result.finalLoss))
                    throw new RangeError('non-finite training loss');
                next.push(this.runtime.prepare(result.model, { maxRows: PREDICT_BATCH }));
                initialLoss += result.initialLoss / this.members;
                finalLoss += result.finalLoss / this.members;
            }
        }
        catch (error) {
            for (const p of next)
                p.dispose();
            if (error instanceof RangeError && error.message === 'non-finite training loss')
                return false; // diverged: decline, keep the old fit
            throw error;
        }
        this.dispose();
        this.prepared = next;
        this.mean = mean;
        this.scale = scale;
        this.inputs = inputs;
        this.lastFit = { rows: rows.length, epochs, initialLoss, finalLoss, backend: this.runtime.backend, members: this.members };
        return true;
    }
    predict(features) {
        if (this.prepared.length === 0)
            throw new Error('FannSurrogate.predict: no fitted model');
        const weight = this.options.explorationWeight ?? 0;
        const out = [];
        for (let start = 0; start < features.length; start += PREDICT_BATCH) {
            const chunk = features.slice(start, start + PREDICT_BATCH);
            const x = new Float64Array(chunk.length * this.inputs);
            chunk.forEach((f, i) => {
                if (f.length !== this.inputs)
                    throw new Error('FannSurrogate.predict: feature length does not match the fitted model');
                x.set(f, i * this.inputs);
            });
            const perMember = this.prepared.map((p) => p.predict(x, chunk.length));
            for (let i = 0; i < chunk.length; i++) {
                let mean = 0;
                for (const values of perMember)
                    mean += values[i];
                mean /= perMember.length;
                let variance = 0;
                for (const values of perMember)
                    variance += (values[i] - mean) ** 2;
                const spread = Math.sqrt(variance / perMember.length);
                out.push((mean + weight * spread) * this.scale + this.mean);
            }
        }
        return out;
    }
    dispose() {
        for (const p of this.prepared)
            p.dispose();
        this.prepared = [];
    }
}
/**
 * Load the optional `ruv-fann` peer and return a surrogate backed by it.
 * Rejects with an actionable message when the package is not installed.
 */
export async function createFannSurrogate(options = {}) {
    // Indirect specifier: keeps bundlers and tsc from hard-resolving the optional peer.
    const specifier = 'ruv-fann';
    let loaded;
    try {
        loaded = (await import(specifier));
    }
    catch (error) {
        throw new Error(`@metaharness/darwin: the ruv-fann surrogate needs the optional peer "ruv-fann" (npm install ruv-fann@0.1.2; Node >= 20.9). ${error.message}`);
    }
    const runtime = await loaded.loadRuntime({ simd: options.simd ?? 'auto' });
    return new FannSurrogate(runtime, loaded.LIMITS, options);
}
//# sourceMappingURL=fann-surrogate.js.map