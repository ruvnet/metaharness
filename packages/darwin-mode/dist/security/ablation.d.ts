import type { Corpus } from './corpus.js';
import type { HarnessGenome } from './types.js';
import { RuvSecurityMemory } from './memory.js';
/**
 * A deliberately HARD corpus: subtle vulnerabilities (detection thresholds up to
 * ~0.95) and adversarial decoys (fp thresholds up to ~0.9) so even a strong
 * harness cannot trivially saturate it. Used to show the champion operates on an
 * unsaturated frontier, not a toy.
 */
export declare function hardCorpus(): Corpus;
/** Aggregate a genome's corpus fitness (optionally with memory). */
export declare function corpusFitness(genome: HarnessGenome, corpus: Corpus, baselineFalsePositiveRate: number, memory?: RuvSecurityMemory): number;
export interface LeverImpact {
    lever: string;
    /** Fitness lost when this lever is knocked out from the champion (≥ 0). */
    delta: number;
}
export interface AblationReport {
    champion: HarnessGenome;
    fullFitness: number;
    levers: LeverImpact[];
    /** The single most important lever by fitness loss. */
    topLever: string;
}
/**
 * Ablate each harness lever from a champion and measure the fitness it loses.
 * A positive delta proves that lever contributes — i.e. the HARNESS, not the
 * frozen model, is producing the gain (ADR-077/155). Deterministic.
 */
export declare function ablate(champion: HarnessGenome, corpus: Corpus, baselineFalsePositiveRate: number): AblationReport;
//# sourceMappingURL=ablation.d.ts.map