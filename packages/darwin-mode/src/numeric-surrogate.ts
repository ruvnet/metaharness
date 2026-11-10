// SPDX-License-Identifier: MIT
//
// Surrogate pre-screening for the numeric genome kind (ADR-272 extension).
//
// The external evaluator is the expensive step of `evolveNumeric` (a training
// run, a benchmark). A surrogate is a cheap learned model of
// `genome → primary`, refit each generation from the archive's own scored
// records, that ranks an oversampled pool of mutation candidates so only the
// most promising ones are sent to the evaluator.
//
// Contract:
//   - The surrogate only ORDERS candidates. It never scores a variant: every
//     archived score still comes from the external evaluator, and promotion
//     still compares evaluator scores. A bad surrogate costs search efficiency,
//     never correctness.
//   - It is fail-open: too few rows, a declined fit, or a thrown error all fall
//     back to the unscreened generation and are recorded in the report.
//   - The evaluator budget is unchanged (`childrenPerGeneration` per parent).
//
// This file is the dependency-free port and the pure selection logic. A
// concrete model lives behind `NumericSurrogate`; `fann-surrogate.ts` provides
// one backed by the optional `ruv-fann` peer.

import { genomeToUnitVector } from './numeric-mutator.js';
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

export type NumericSurrogateEvent =
  | { readonly generation: number; readonly screened: true; readonly rows: number; readonly ranked: number; readonly selected: number; readonly holdoutSpearman?: number }
  | { readonly generation: number; readonly screened: false; readonly reason: string };

/** What the pre-screen did over a run — carried on `NumericEvolutionResult.surrogate`. */
export interface NumericSurrogateReport {
  /** Generations in which candidates were actually ranked by the surrogate. */
  readonly generationsScreened: number;
  /** Candidates the surrogate ranked, summed over those generations. */
  readonly candidatesRanked: number;
  /** Candidates it ranked that then went to the evaluator. */
  readonly candidatesSelected: number;
  /** One entry per generation that fell back to unscreened, with the reason. */
  readonly fallbacks: readonly { readonly generation: number; readonly reason: string }[];
}

export const DEFAULT_SURROGATE_OVERSAMPLE = 4;
export const DEFAULT_SURROGATE_MIN_ROWS = 12;
export const DEFAULT_SURROGATE_EXPLORE_SLOTS = 1;
export const DEFAULT_SURROGATE_HOLDOUT_FRACTION = 0.25;

/** Reject nonsensical settings up front rather than silently misbehaving mid-run. */
export function validateSurrogateConfig(config: NumericSurrogateConfig): void {
  const int = (name: string, value: number | undefined, min: number): void => {
    if (value !== undefined && (!Number.isInteger(value) || value < min)) {
      throw new RangeError(`surrogate.${name} must be an integer >= ${min} (got ${value})`);
    }
  };
  int('oversample', config.oversample, 2);
  int('minRows', config.minRows, 2);
  int('exploreSlots', config.exploreSlots, 0);
  int('warmupGenerations', config.warmupGenerations, 0);
  int('refitEvery', config.refitEvery, 1);
  if (config.trust) {
    const { minSpearman, holdoutFraction } = config.trust;
    if (!(minSpearman >= -1 && minSpearman <= 1)) throw new RangeError('surrogate.trust.minSpearman must be in [-1, 1]');
    if (holdoutFraction !== undefined && !(holdoutFraction > 0 && holdoutFraction <= 0.5)) {
      throw new RangeError('surrogate.trust.holdoutFraction must be in (0, 0.5]');
    }
  }
}

function ranks(values: readonly number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]]) j++;
    const mean = (i + j) / 2 + 1; // average rank across ties
    for (let k = i; k <= j; k++) out[order[k]] = mean;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation (ties get average ranks). 0 when either side is constant or n < 2. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ra = ranks(a.slice(0, n));
  const rb = ranks(b.slice(0, n));
  const mean = (n + 1) / 2;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - mean) * (rb[i] - mean);
    va += (ra[i] - mean) ** 2;
    vb += (rb[i] - mean) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

export type SurrogateFitOutcome =
  | { readonly ready: true; readonly holdoutSpearman?: number }
  | { readonly ready: false; readonly reason: string };

/**
 * Fit `model` on `rows`, applying the optional trust gate. Never throws: a
 * declined fit, a failed gate or an error from the model all come back as
 * `{ ready: false, reason }` so the caller can fall back to unscreened.
 */
export async function fitSurrogate(
  model: NumericSurrogate,
  rows: readonly SurrogateRow[],
  trust?: NumericSurrogateTrust,
): Promise<SurrogateFitOutcome> {
  try {
    let holdoutSpearman: number | undefined;
    if (trust) {
      const every = Math.max(2, Math.round(1 / (trust.holdoutFraction ?? DEFAULT_SURROGATE_HOLDOUT_FRACTION)));
      const train = rows.filter((_, i) => i % every !== every - 1);
      const holdout = rows.filter((_, i) => i % every === every - 1);
      if (holdout.length < 3) return { ready: false, reason: `trust gate: only ${holdout.length} held-out rows (need 3)` };
      if (!(await model.fit(train))) return { ready: false, reason: 'trust gate: surrogate declined the training split' };
      holdoutSpearman = spearman(
        model.predict(holdout.map((r) => r.features)),
        holdout.map((r) => r.target),
      );
      if (holdoutSpearman < trust.minSpearman) {
        return { ready: false, reason: `trust gate: held-out Spearman ${holdoutSpearman.toFixed(3)} < ${trust.minSpearman}` };
      }
    }
    if (!(await model.fit(rows))) return { ready: false, reason: 'surrogate declined to fit' };
    return { ready: true, holdoutSpearman };
  } catch (error) {
    return { ready: false, reason: `surrogate error: ${(error as Error).message}` };
  }
}

/**
 * Training rows from the archive. Unscored records and evaluator failures carry
 * no information and are dropped. A `regressed` record is a hard fail whatever
 * its `primary`, so its target is floored to the worst non-regressed primary —
 * the surrogate learns to steer away from that region rather than toward it.
 */
export function surrogateRowsFromArchive(
  records: readonly NumericArchiveRecord[],
  genomeSpec: NumericGenomeSpec,
): SurrogateRow[] {
  const usable = records.filter(
    (r) => r.score !== null && r.score.evaluatorError === undefined && Number.isFinite(r.score.primary),
  );
  let floor = Infinity;
  for (const r of usable) if (!r.score!.regressed) floor = Math.min(floor, r.score!.primary);
  return usable.map((r) => {
    const score = r.score!;
    const target = score.regressed && Number.isFinite(floor) ? Math.min(score.primary, floor) : score.primary;
    return { features: genomeToUnitVector(r.variant.genome, genomeSpec), target };
  });
}

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
export function selectByPrediction(predictions: readonly number[], slots: number, exploreSlots: number): ScreenedPick[] {
  const n = predictions.length;
  const take = Math.min(Math.max(0, slots), n);
  const safe = predictions.map((p) => (Number.isFinite(p) ? p : -Infinity));
  const order = safe.map((_, i) => i).sort((a, b) => safe[b] - safe[a] || a - b);
  const rank = new Array<number>(n);
  order.forEach((poolIndex, position) => {
    rank[poolIndex] = position + 1;
  });
  const explore = Math.min(Math.max(0, exploreSlots), take);
  const picks = new Map<number, ScreenedPick>();
  for (let i = 0; i < explore; i++) picks.set(i, { poolIndex: i, kind: 'explore', rank: rank[i], predicted: predictions[i] });
  for (const poolIndex of order) {
    if (picks.size >= take) break;
    if (picks.has(poolIndex)) continue;
    picks.set(poolIndex, { poolIndex, kind: 'predicted', rank: rank[poolIndex], predicted: predictions[poolIndex] });
  }
  return [...picks.values()].sort((a, b) => a.poolIndex - b.poolIndex);
}
