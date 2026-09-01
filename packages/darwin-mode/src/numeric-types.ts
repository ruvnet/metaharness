// SPDX-License-Identifier: MIT
//
// Darwin Mode — numeric genome kind (ADR-272). A second, parallel genome
// representation alongside the seven-surface prompt genome (ADR-071): a
// bounded vector of named numeric parameters (e.g. ML training
// hyperparameters), mutated by bounded perturbation/crossover instead of code
// generation, and scored by a caller-supplied external evaluator instead of
// the built-in SWE-bench-style sandbox.
//
// Deliberately independent of `types.ts`'s `HarnessVariant`/`MutationSurface`:
// those are irreducibly coupled to "a directory of seven source files" (ADR-071
// safety allowlist). A numeric hyperparameter vector is not a mutation-surface
// safety domain, so it gets its own types rather than widening that allowlist's
// union — widening it would blur the boundary the allowlist exists to hold.

/** How a parameter's bounds are interpreted when perturbing/crossing over. */
export type NumericScale = 'linear' | 'log';

/** Numeric or integer-valued parameter. */
export type NumericParamType = 'float' | 'int';

/** Bounds + type for one named parameter in a numeric genome. */
export interface NumericParamSpec {
  readonly min: number;
  readonly max: number;
  readonly scale: NumericScale;
  readonly type: NumericParamType;
  /** Optional starting value for the baseline genome; defaults to the bounds' midpoint. */
  readonly default?: number;
}

/** The full parameter space: name → bounds. */
export type NumericGenomeSpec = Readonly<Record<string, NumericParamSpec>>;

/** A concrete point in that space: name → value. */
export type NumericGenome = Readonly<Record<string, number>>;

/** One numeric-genome variant (the numeric-kind analogue of `HarnessVariant`). */
export interface NumericVariant {
  readonly id: string;
  readonly parentId: string | null;
  readonly generation: number;
  readonly genome: NumericGenome;
  /** Which parameter(s) this variant changed relative to its parent. */
  readonly mutatedParams: readonly string[];
  readonly mutationSummary: string;
  readonly createdAt: string;
}

/**
 * Evidence returned by the external evaluator for one genome, shaped to plug
 * directly into a `ruviewPromotionRule`-style gate (same fields as
 * `harness/ruview/flywheel/gate.mjs`'s `evaluateGenome` result): `primary`
 * higher-is-better, `regressed` a hard fail, `noopRate`/`costPerWin` secondary
 * signals. `raw` carries the evaluator's domain-specific payload (e.g. WQL
 * numbers) for reporting — never interpreted by the engine itself.
 */
export interface NumericScoreCard {
  readonly variantId: string;
  readonly primary: number;
  readonly regressed: boolean;
  readonly noopRate: number;
  readonly costPerWin: number;
  readonly raw?: unknown;
  readonly evaluatorError?: string;
}

/** One node in the numeric archive tree. */
export interface NumericArchiveRecord {
  readonly variant: NumericVariant;
  score: NumericScoreCard | null;
  readonly children: string[];
}

/**
 * An external evaluator: given a genome, returns its fitness. Darwin Mode
 * never runs training/scoring code itself for the numeric kind — it shells out
 * to this, exactly once per candidate, and treats the result as opaque
 * evidence. The default `ShellEvaluator` (numeric-evaluator.ts) spawns a
 * command with the genome as JSON on stdin and parses a `NumericScoreCard`-
 * shaped JSON object from stdout — matching this interface lets a caller
 * supply an in-process evaluator instead (e.g. in tests).
 */
export interface NumericEvaluator {
  evaluate(genome: NumericGenome, variantId: string): Promise<NumericScoreCard>;
}

/** Configuration for a full numeric-genome `evolveNumeric` run. */
export interface NumericEvolutionConfig {
  readonly genomeSpec: NumericGenomeSpec;
  readonly evaluator: NumericEvaluator;
  readonly generations: number;
  readonly childrenPerGeneration: number;
  /** Deterministic seed for mutation/crossover selection. Default 0. */
  readonly seed?: number;
  /** Max candidates evaluated concurrently. Default 4. */
  readonly concurrency?: number;
  /**
   * Relative perturbation strength for the default Gaussian mutator, as a
   * fraction of each parameter's [min,max] (or [log min, log max]) span.
   * Default 0.2 (20%).
   */
  readonly mutationSigma?: number;
  /**
   * Opt-in crossover (ADR-272, mirrors ADR-089 for the prompt kind): when true
   * and a generation has ≥2 parents, the first child of each parent recombines
   * with the next parent's genome (uniform per-parameter pick) instead of
   * mutating. Default false → mutation-only.
   */
  readonly crossover?: boolean;
  /** Absolute path to the `.metaharness-numeric` work tree (archive.json etc.). */
  readonly workRoot: string;
  /** Optional explicit baseline genome; defaults to each parameter's `default` or bounds midpoint. */
  readonly baselineGenome?: NumericGenome;
}

/** The outcome of a numeric `evolveNumeric` run. */
export interface NumericEvolutionResult {
  readonly baseline: NumericArchiveRecord;
  readonly winner: NumericArchiveRecord | null;
  readonly records: readonly NumericArchiveRecord[];
  readonly generations: number;
  readonly winnerLineage: readonly string[];
}
