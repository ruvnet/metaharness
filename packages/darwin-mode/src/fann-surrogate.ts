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

import type { NumericSurrogate, SurrogateRow } from './numeric-surrogate.js';

/** Minimal surface of `ruv-fann` used here — local, so the published types carry no dependency on the optional package. */
interface FannLayer {
  inputs: number;
  outputs: number;
  weights: number[];
  bias: number[];
  activation: FannHiddenActivation | 'Linear';
  steepness: number;
}
interface FannModel {
  schema: 'ruv-fann.dense-layers/1';
  layers: FannLayer[];
}
interface FannPrepared {
  readonly maxRows: number;
  predict(inputs: Float64Array, rows?: number): Float64Array;
  dispose(): void;
}
interface FannRuntime {
  readonly backend: string;
  prepare(model: unknown, options?: { maxRows?: number }): FannPrepared;
  train(
    model: FannModel,
    options: { inputs: Float64Array; targets: Float64Array; rows: number; epochs: number; learningRate: number; optimizer?: 'sgd' | 'adamw' },
  ): { model: unknown; initialLoss: number; finalLoss: number; epochs: number };
}
interface FannModule {
  loadRuntime(options?: { simd?: boolean | 'auto' }): Promise<FannRuntime>;
  LIMITS: { maxRows: number; maxTrainingWork: number };
}

/** Hidden-layer activations ruv-fann can train. */
export type FannHiddenActivation = 'Tanh' | 'Sigmoid' | 'SigmoidSymmetric' | 'ReLU';

export interface FannSurrogateOptions {
  /** Hidden-layer width, or one width per hidden layer (e.g. `[16, 8]`). Default 8. */
  readonly hidden?: number | readonly number[];
  /** Hidden-layer activation. Default 'Tanh'. */
  readonly activation?: FannHiddenActivation;
  /** Activation steepness for the hidden layers. Default 1. */
  readonly steepness?: number;
  /** Requested full-batch epochs; lowered automatically to fit ruv-fann's per-call work budget. Default 300. */
  readonly epochs?: number;
  /** Default 0.03. */
  readonly learningRate?: number;
  /** Default 'adamw'. */
  readonly optimizer?: 'sgd' | 'adamw';
  /** Seed for the weight initialisation. Default 0. */
  readonly seed?: number;
  /** Only the most recent `maxRows` rows are trained on. Default 256. */
  readonly maxRows?: number;
  /** Passed to ruv-fann's `loadRuntime`. Default 'auto'. */
  readonly simd?: boolean | 'auto';
  /**
   * How targets are scaled before training. 'standardize' (default) is a
   * z-score. 'rank' trains on the targets' ranks instead — robust to outliers
   * and heavy-tailed metrics; predictions are then in rank space (0 = worst
   * seen, 1 = best seen), which is all a ranking needs.
   */
  readonly targetTransform?: 'standardize' | 'rank';
  /**
   * Train this many independently initialised networks (seeds `seed`,
   * `seed + 1`, …) and predict with their mean. Smooths out initialisation
   * noise on small archives at N× the fit cost. Integer 1–16, default 1.
   */
  readonly ensemble?: number;
  /**
   * Upper-confidence-bound bonus: predictions become `mean + weight · stddev`
   * across the ensemble, favouring candidates the members disagree on (i.e.
   * unexplored regions). Needs `ensemble >= 2` to have any effect. Default 0.
   */
  readonly explorationWeight?: number;
}

/** Details of the most recent successful fit, for reports and receipts. */
export interface FannFitInfo {
  readonly rows: number;
  readonly epochs: number;
  readonly initialLoss: number;
  readonly finalLoss: number;
  readonly backend: string;
  /** Networks trained (the ensemble size). */
  readonly members: number;
}

const PREDICT_BATCH = 256;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function initialModel(inputs: number, hidden: readonly number[], activation: FannHiddenActivation, steepness: number, seed: number): FannModel {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const layer = (i: number, o: number, act: FannLayer['activation'], steep: number): FannLayer => {
    const limit = Math.sqrt(6 / (i + o)); // Glorot-uniform
    return {
      inputs: i,
      outputs: o,
      weights: Array.from({ length: i * o }, () => (rand() * 2 - 1) * limit),
      bias: new Array<number>(o).fill(0),
      activation: act,
      steepness: steep,
    };
  };
  const layers: FannLayer[] = [];
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
export function fannEpochBudget(rows: number, inputs: number, hidden: number | readonly number[], maxTrainingWork: number): number {
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

export class FannSurrogate implements NumericSurrogate {
  /** The most recent successful fit, or null. */
  lastFit: FannFitInfo | null = null;
  private prepared: FannPrepared[] = [];
  private readonly hidden: readonly number[];
  private readonly members: number;
  private mean = 0; // of the (possibly rank-transformed) targets
  private scale = 1;
  private inputs = 0;

  constructor(
    private readonly runtime: FannRuntime,
    private readonly limits: FannModule['LIMITS'],
    private readonly options: FannSurrogateOptions = {},
  ) {
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
    for (const [name, value] of [['epochs', options.epochs], ['learningRate', options.learningRate], ['steepness', options.steepness], ['maxRows', options.maxRows]] as const) {
      if (value !== undefined && !(value > 0)) throw new RangeError(`FannSurrogate: ${name} must be positive`);
    }
  }

  async fit(allRows: readonly SurrogateRow[]): Promise<boolean> {
    const maxRows = Math.min(this.options.maxRows ?? 256, this.limits.maxRows);
    const rows = allRows.slice(-maxRows);
    const inputs = rows[0]?.features.length ?? 0;
    if (rows.length < 2 || inputs === 0) return false;

    // Scale targets so one learning rate suits any `primary` scale.
    let targets = rows.map((r) => r.target);
    const rankMode = this.options.targetTransform === 'rank';
    if (rankMode) {
      const order = targets.map((_, i) => i).sort((p, q) => targets[p] - targets[q] || p - q);
      const ranked = new Array<number>(targets.length);
      for (let i = 0; i < order.length; ) {
        let j = i;
        while (j + 1 < order.length && targets[order[j + 1]] === targets[order[i]]) j++;
        for (let k = i; k <= j; k++) ranked[order[k]] = (i + j) / 2 / (targets.length - 1);
        i = j + 1;
      }
      targets = ranked;
    }
    let mean = 0;
    for (const t of targets) mean += t;
    mean /= targets.length;
    let variance = 0;
    for (const t of targets) variance += (t - mean) ** 2;
    const scale = Math.sqrt(variance / targets.length);
    if (!(scale > 0) || !Number.isFinite(scale)) return false; // constant targets: nothing to rank by

    const epochs = Math.min(
      Math.floor(this.options.epochs ?? 300),
      fannEpochBudget(rows.length, inputs, this.hidden, this.limits.maxTrainingWork),
    );
    if (epochs < 1) return false;

    const x = new Float64Array(rows.length * inputs);
    const y = new Float64Array(rows.length);
    rows.forEach((r, i) => {
      if (r.features.length !== inputs) throw new Error('FannSurrogate.fit: rows have inconsistent feature lengths');
      x.set(r.features, i * inputs);
      y[i] = (targets[i] - mean) / scale;
    });

    const next: FannPrepared[] = [];
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
        if (!Number.isFinite(result.finalLoss)) throw new RangeError('non-finite training loss');
        next.push(this.runtime.prepare(result.model, { maxRows: PREDICT_BATCH }));
        initialLoss += result.initialLoss / this.members;
        finalLoss += result.finalLoss / this.members;
      }
    } catch (error) {
      for (const p of next) p.dispose();
      if (error instanceof RangeError && error.message === 'non-finite training loss') return false; // diverged: decline, keep the old fit
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

  predict(features: readonly (readonly number[])[]): number[] {
    if (this.prepared.length === 0) throw new Error('FannSurrogate.predict: no fitted model');
    const weight = this.options.explorationWeight ?? 0;
    const out: number[] = [];
    for (let start = 0; start < features.length; start += PREDICT_BATCH) {
      const chunk = features.slice(start, start + PREDICT_BATCH);
      const x = new Float64Array(chunk.length * this.inputs);
      chunk.forEach((f, i) => {
        if (f.length !== this.inputs) throw new Error('FannSurrogate.predict: feature length does not match the fitted model');
        x.set(f, i * this.inputs);
      });
      const perMember = this.prepared.map((p) => p.predict(x, chunk.length));
      for (let i = 0; i < chunk.length; i++) {
        let mean = 0;
        for (const values of perMember) mean += values[i];
        mean /= perMember.length;
        let variance = 0;
        for (const values of perMember) variance += (values[i] - mean) ** 2;
        const spread = Math.sqrt(variance / perMember.length);
        out.push((mean + weight * spread) * this.scale + this.mean);
      }
    }
    return out;
  }

  dispose(): void {
    for (const p of this.prepared) p.dispose();
    this.prepared = [];
  }
}

/**
 * Load the optional `ruv-fann` peer and return a surrogate backed by it.
 * Rejects with an actionable message when the package is not installed.
 */
export async function createFannSurrogate(options: FannSurrogateOptions = {}): Promise<FannSurrogate> {
  // Indirect specifier: keeps bundlers and tsc from hard-resolving the optional peer.
  const specifier = 'ruv-fann';
  let loaded: FannModule;
  try {
    loaded = (await import(specifier)) as FannModule;
  } catch (error) {
    throw new Error(
      `@metaharness/darwin: the ruv-fann surrogate needs the optional peer "ruv-fann" (npm install ruv-fann@0.1.2; Node >= 20.9). ${(error as Error).message}`,
    );
  }
  const runtime = await loaded.loadRuntime({ simd: options.simd ?? 'auto' });
  return new FannSurrogate(runtime, loaded.LIMITS, options);
}
