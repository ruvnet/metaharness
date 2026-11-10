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
    prepare(model: unknown, options?: {
        maxRows?: number;
    }): FannPrepared;
    train(model: FannModel, options: {
        inputs: Float64Array;
        targets: Float64Array;
        rows: number;
        epochs: number;
        learningRate: number;
        optimizer?: 'sgd' | 'adamw';
    }): {
        model: unknown;
        initialLoss: number;
        finalLoss: number;
        epochs: number;
    };
}
interface FannModule {
    loadRuntime(options?: {
        simd?: boolean | 'auto';
    }): Promise<FannRuntime>;
    LIMITS: {
        maxRows: number;
        maxTrainingWork: number;
    };
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
/**
 * Largest epoch count ruv-fann will accept for this shape. Mirrors its
 * published bound: backward·(epochs+1) + update·epochs ≤ maxTrainingWork.
 */
export declare function fannEpochBudget(rows: number, inputs: number, hidden: number | readonly number[], maxTrainingWork: number): number;
export declare class FannSurrogate implements NumericSurrogate {
    private readonly runtime;
    private readonly limits;
    private readonly options;
    /** The most recent successful fit, or null. */
    lastFit: FannFitInfo | null;
    private prepared;
    private readonly hidden;
    private readonly members;
    private mean;
    private scale;
    private inputs;
    constructor(runtime: FannRuntime, limits: FannModule['LIMITS'], options?: FannSurrogateOptions);
    fit(allRows: readonly SurrogateRow[]): Promise<boolean>;
    predict(features: readonly (readonly number[])[]): number[];
    dispose(): void;
}
/**
 * Load the optional `ruv-fann` peer and return a surrogate backed by it.
 * Rejects with an actionable message when the package is not installed.
 */
export declare function createFannSurrogate(options?: FannSurrogateOptions): Promise<FannSurrogate>;
export {};
//# sourceMappingURL=fann-surrogate.d.ts.map