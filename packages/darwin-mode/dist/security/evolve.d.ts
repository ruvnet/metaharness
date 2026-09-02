import type { Corpus } from './corpus.js';
import type { HarnessGenome } from './types.js';
import type { FitnessBreakdown } from './scoring.js';
import { RuvSecurityMemory } from './memory.js';
export interface EvolveConfig {
    corpus: Corpus;
    /** Population size per cycle (ADR-155 default 16). */
    population: number;
    /** Evolution cycles (ADR-155 default 50). */
    cycles: number;
    seed?: number;
    /** Base genome to evolve from (default the fixed baseline). */
    base?: HarnessGenome;
    /** Compounding memory; when supplied, populations seed from prior winners. */
    memory?: RuvSecurityMemory;
    /** Baseline FP rate for the false-positive-reduction fitness term. */
    baselineFalsePositiveRate: number;
    /** Fraction of each cycle's population kept as elites (default 0.25). */
    eliteFraction?: number;
    /** Enable crossover between elites (default true). */
    crossover?: boolean;
}
export interface ScoredGenome {
    genome: HarnessGenome;
    breakdown: FitnessBreakdown;
}
export interface EvolveResult {
    champion: ScoredGenome;
    baseline: ScoredGenome;
    /** Best fitness per cycle (the learning curve). */
    history: number[];
    /** Champion lineage (genome ids, base → champion). */
    lineage: string[];
    cyclesRun: number;
    evaluations: number;
}
/** Score one genome over the whole corpus → fitness breakdown. */
export declare function evaluate(genome: HarnessGenome, cfg: EvolveConfig, taskId: string): ScoredGenome;
/** Run the full evolutionary search. Returns the champion + learning curve. */
export declare function evolve(cfg: EvolveConfig): EvolveResult;
//# sourceMappingURL=evolve.d.ts.map