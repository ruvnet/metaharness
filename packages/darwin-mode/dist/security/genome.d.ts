import type { HarnessGenome, SecurityTool } from './types.js';
export declare const PLANNERS: readonly HarnessGenome['planner'][];
export declare const CONTEXT_POLICIES: readonly HarnessGenome['contextPolicy'][];
export declare const ALL_TOOLS: readonly SecurityTool[];
/** Bounds for the numeric knobs (the safe envelope). */
export declare const BOUNDS: {
    readonly reviewerCount: readonly [1, 5];
    readonly retryBudget: readonly [1, 6];
    readonly fuzzBudgetSeconds: readonly [10, 600];
};
/**
 * The baseline genome — a reasonable fixed harness (the `B2 fixed-agent`
 * benchmark baseline). Darwin Mode must beat THIS by ≥25% to be accepted.
 */
export declare function baselineGenome(): HarnessGenome;
/** A stricter static-only baseline (`B0`): tools, no LLM reasoning/review. */
export declare function staticOnlyGenome(): HarnessGenome;
/** A single-pass LLM baseline (`B1`): one model, minimal context, one review. */
export declare function llmSinglePassGenome(): HarnessGenome;
/**
 * Mutate a parent into a bounded child. Each call perturbs a handful of knobs;
 * the safety profile and id-lineage are preserved. Deterministic for a fixed RNG.
 */
export declare function mutate(parent: HarnessGenome, rng: () => number, generation: number, index: number): HarnessGenome;
/**
 * Uniform crossover of two parents (ADR-155 swarm §crossover). Each knob is
 * inherited from one parent or the other; the safety profile is fixed. The child
 * stays inside the safe envelope because both parents already are.
 */
export declare function crossover(a: HarnessGenome, b: HarnessGenome, rng: () => number, generation: number, index: number): HarnessGenome;
/** True iff a genome respects every bound and the immutable safety profile. */
export declare function isGenomeValid(g: HarnessGenome): boolean;
/**
 * Seed an initial population from a base genome by repeated mutation. If
 * `seeds` are supplied (from ruVector genome memory, ADR-155 §genome memory),
 * they prefix the population so evolution starts from prior winners.
 */
export declare function seedPopulation(base: HarnessGenome, size: number, seed: number, seeds?: HarnessGenome[]): HarnessGenome[];
//# sourceMappingURL=genome.d.ts.map