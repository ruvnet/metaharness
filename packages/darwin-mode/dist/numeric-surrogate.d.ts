import type { NumericArchiveRecord, NumericGenomeSpec } from './numeric-types.js';
/** One training observation: a unit-space genome vector and its (higher-is-better) target. */
export interface SurrogateRow {
    readonly features: readonly number[];
    readonly target: number;
}
/** A cheap learned model of `genome → primary`. */
export interface NumericSurrogate {
    /**
     * Refit from scratch on `rows`. Resolve `false` to decline (e.g. no signal in
     * the targets) — the generation then runs unscreened.
     */
    fit(rows: readonly SurrogateRow[]): Promise<boolean>;
    /** Predicted target per feature vector. Only called after `fit` resolved `true`. */
    predict(features: readonly (readonly number[])[]): number[];
    /** Release any native resources. Called by whoever created the surrogate. */
    dispose?(): void;
}
export interface NumericSurrogateConfig {
    readonly model: NumericSurrogate;
    /** Mutation candidates proposed per evaluated slot. Integer ≥ 2, default 4. */
    readonly oversample?: number;
    /** Scored archive rows required before the surrogate is consulted. Default 12. */
    readonly minRows?: number;
    /**
     * Per parent, how many slots keep the candidate the unscreened loop would
     * have produced, regardless of prediction — exploration the surrogate cannot
     * veto. Capped so at least one slot is screened. Default 1.
     */
    readonly exploreSlots?: number;
    /** Generations (after the baseline) that always run unscreened, whatever the row count. Default 0. */
    readonly warmupGenerations?: number;
    /**
     * Refit cadence: the surrogate is refit every N generations and the previous
     * fit is reused in between. Default 1 (refit every generation).
     */
    readonly refitEvery?: number;
    /**
     * Opt-in trust gate. Before each (re)fit is used, the model is first fit on a
     * training split and must rank a held-out split at least this well; if it
     * does not, the generation runs unscreened. On pass it is refit on all rows.
     * Costs one extra fit per refit.
     */
    readonly trust?: NumericSurrogateTrust;
    /** Called once per generation with what the pre-screen did — for logs and receipts. */
    readonly onGeneration?: (event: NumericSurrogateEvent) => void;
}
export interface NumericSurrogateTrust {
    /** Minimum Spearman rank correlation between predictions and held-out targets, in [-1, 1]. */
    readonly minSpearman: number;
    /** Fraction of rows held out, in (0, 0.5]. Default 0.25. */
    readonly holdoutFraction?: number;
}
export type NumericSurrogateEvent = {
    readonly generation: number;
    readonly screened: true;
    readonly rows: number;
    readonly ranked: number;
    readonly selected: number;
    readonly holdoutSpearman?: number;
} | {
    readonly generation: number;
    readonly screened: false;
    readonly reason: string;
};
/** What the pre-screen did over a run — carried on `NumericEvolutionResult.surrogate`. */
export interface NumericSurrogateReport {
    /** Generations in which candidates were actually ranked by the surrogate. */
    readonly generationsScreened: number;
    /** Candidates the surrogate ranked, summed over those generations. */
    readonly candidatesRanked: number;
    /** Candidates it ranked that then went to the evaluator. */
    readonly candidatesSelected: number;
    /** One entry per generation that fell back to unscreened, with the reason. */
    readonly fallbacks: readonly {
        readonly generation: number;
        readonly reason: string;
    }[];
}
export declare const DEFAULT_SURROGATE_OVERSAMPLE = 4;
export declare const DEFAULT_SURROGATE_MIN_ROWS = 12;
export declare const DEFAULT_SURROGATE_EXPLORE_SLOTS = 1;
export declare const DEFAULT_SURROGATE_HOLDOUT_FRACTION = 0.25;
/** Reject nonsensical settings up front rather than silently misbehaving mid-run. */
export declare function validateSurrogateConfig(config: NumericSurrogateConfig): void;
/** Spearman rank correlation (ties get average ranks). 0 when either side is constant or n < 2. */
export declare function spearman(a: readonly number[], b: readonly number[]): number;
export type SurrogateFitOutcome = {
    readonly ready: true;
    readonly holdoutSpearman?: number;
} | {
    readonly ready: false;
    readonly reason: string;
};
/**
 * Fit `model` on `rows`, applying the optional trust gate. Never throws: a
 * declined fit, a failed gate or an error from the model all come back as
 * `{ ready: false, reason }` so the caller can fall back to unscreened.
 */
export declare function fitSurrogate(model: NumericSurrogate, rows: readonly SurrogateRow[], trust?: NumericSurrogateTrust): Promise<SurrogateFitOutcome>;
/**
 * Training rows from the archive. Unscored records and evaluator failures carry
 * no information and are dropped. A `regressed` record is a hard fail whatever
 * its `primary`, so its target is floored to the worst non-regressed primary —
 * the surrogate learns to steer away from that region rather than toward it.
 */
export declare function surrogateRowsFromArchive(records: readonly NumericArchiveRecord[], genomeSpec: NumericGenomeSpec): SurrogateRow[];
/** The outcome of ranking one parent's candidate pool. */
export interface ScreenedPick {
    /** Index into the pool passed to `selectByPrediction`. */
    readonly poolIndex: number;
    readonly kind: 'explore' | 'predicted';
    /** 1-based rank by prediction within the pool (1 = best). */
    readonly rank: number;
    readonly predicted: number;
}
/**
 * Choose `slots` candidates from a pool. The first `exploreSlots` pool entries
 * are kept unconditionally (callers put the unscreened loop's own candidates
 * first); the rest of the slots go to the best-predicted remaining entries.
 * Ties and non-finite predictions resolve to pool order, so the result is
 * deterministic. Picks are returned in pool order.
 */
export declare function selectByPrediction(predictions: readonly number[], slots: number, exploreSlots: number): ScreenedPick[];
//# sourceMappingURL=numeric-surrogate.d.ts.map