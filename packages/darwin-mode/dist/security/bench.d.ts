import type { Corpus } from './corpus.js';
import { type FitnessBreakdown } from './scoring.js';
import { type PromotionDecision } from './stats.js';
import { type CompoundingReport } from './compounding.js';
import { type AblationReport } from './ablation.js';
import type { HarnessGenome } from './types.js';
export interface BaselineReport {
    name: string;
    genome: HarnessGenome;
    breakdown: FitnessBreakdown;
    /** Reproducibility: re-running yields the identical receipt hash. */
    reproHash: string;
}
export interface AcceptanceGate {
    name: string;
    pass: boolean;
    detail: string;
}
export interface BenchReport {
    corpusId: string;
    corpusVersion: string;
    groundTruth: number;
    decoys: number;
    baselines: BaselineReport[];
    champion: BaselineReport;
    gates: AcceptanceGate[];
    passed: boolean;
    cyclesRun: number;
    championLineage: string[];
    learningCurve: number[];
    /** Seeded-bootstrap verdict: champion vs the pre-evolution fixed harness. */
    statisticalPromotion: PromotionDecision;
    /** Cross-run ruVector compounding acceptance (the moat: memory compounds). */
    compounding: CompoundingReport;
    /** Lever ablation of the champion — proves the HARNESS drives the gain. */
    ablation: AblationReport;
}
export interface BenchConfig {
    corpus?: Corpus;
    population?: number;
    cycles?: number;
    seed?: number;
}
/** Run the whole benchmark and evaluate the acceptance gates. */
export declare function runBenchmark(config?: BenchConfig): BenchReport;
/** Champion vs fixed-harness on the HARD corpus — proves an unsaturated frontier. */
export interface StressResult {
    championTpr: number;
    championFpr: number;
    championFitness: number;
    baselineTpr: number;
    baselineFitness: number;
    /** Champion has headroom (does not saturate at TPR 1.0). */
    hasHeadroom: boolean;
    /** Champion still beats the fixed harness on the hard frontier. */
    beatsBaseline: boolean;
}
/**
 * Evolve on the deliberately HARD corpus (subtle vulns + adversarial decoys) and
 * report the champion vs the fixed harness. A "beyond SOTA" claim is only honest
 * if the champion is on an unsaturated frontier (TPR < 1.0) yet still dominates.
 */
export declare function hardCorpusStressTest(config?: BenchConfig): StressResult;
/** Render a benchmark report as Markdown (for bench/results/RESULTS.md). */
export declare function renderReport(report: BenchReport): string;
//# sourceMappingURL=bench.d.ts.map