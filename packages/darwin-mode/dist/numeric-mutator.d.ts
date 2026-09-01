import type { NumericGenome, NumericGenomeSpec, NumericVariant } from './numeric-types.js';
/** Each parameter's bounds midpoint (or explicit `default`) — the baseline genome. */
export declare function defaultGenome(genomeSpec: NumericGenomeSpec): NumericGenome;
/**
 * Perturb every parameter of `parent` by independent bounded Gaussian noise
 * (in unit-interval space, so `log`-scale parameters like a learning rate are
 * perturbed multiplicatively, not additively) and return the mutated genome
 * plus which parameters actually changed value. `sigma` is the noise stddev as
 * a fraction of each parameter's unit span (e.g. 0.2 = 20%).
 */
export declare function mutateGenome(parent: NumericGenome, genomeSpec: NumericGenomeSpec, seed: number, generation: number, index: number, sigma: number): {
    genome: NumericGenome;
    mutatedParams: string[];
};
/**
 * Uniform crossover (ADR-272, mirrors ADR-089's surface crossover): each
 * parameter is independently inherited from `parentA` or `parentB`, chosen by
 * a deterministic coin flip. Always adopts a proper, non-empty subset from B
 * (never all-A, never all-B) so the child is genuinely a recombination.
 */
export declare function crossoverGenome(parentA: NumericGenome, parentB: NumericGenome, genomeSpec: NumericGenomeSpec, seed: number, generation: number, index: number): {
    genome: NumericGenome;
    fromB: string[];
};
/** Build a `NumericVariant` from a mutation result. */
export declare function makeVariant(parent: NumericVariant | null, generation: number, index: number, genome: NumericGenome, mutatedParams: string[], summary: string): NumericVariant;
//# sourceMappingURL=numeric-mutator.d.ts.map