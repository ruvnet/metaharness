import type { BenchmarkReceipt, Finding, HarnessGenome, RunMetrics } from './types.js';
import type { Corpus } from './corpus.js';
import { RuvSecurityMemory } from './memory.js';
export interface SwarmOptions {
    /** Compounding memory. When supplied, findings are written back (archive-curator). */
    memory?: RuvSecurityMemory;
    /** Persist confirmed findings / false positives into memory after the run. */
    writeBack?: boolean;
    seed?: number;
}
export interface SwarmRunResult {
    genome: HarnessGenome;
    /** The gated, safe findings (confirmed + false positives that leaked). */
    findings: Finding[];
    metrics: RunMetrics;
    receipt: BenchmarkReceipt;
}
/**
 * A deterministic cost proxy: more reviewers, more tools, deeper context, and a
 * bigger fuzz budget all cost more compute. Gives the cost-efficiency fitness
 * term a real gradient without measuring wall-clock (which would be non-repro).
 */
export declare function costOf(genome: HarnessGenome): number;
/**
 * Per-repo metrics for one genome — the per-task SAMPLE DISTRIBUTION the
 * statistical promotion gate (stats.ts, ADR-079/155) bootstraps over. Aggregating
 * to a single number throws away the variance a champion-vs-champion comparison
 * needs to be more than one lucky run. Deterministic.
 */
export declare function runSwarmPerRepo(genome: HarnessGenome, corpus: Corpus, opts?: SwarmOptions): Array<{
    repo: string;
    metrics: RunMetrics;
}>;
/** Run the full defensive swarm for one genome over the whole corpus. */
export declare function runSwarm(genome: HarnessGenome, corpus: Corpus, taskId: string, opts?: SwarmOptions): SwarmRunResult;
/** A tamper-evident hash over the run's inputs (for replay/audit). */
export declare function hashInputs(genome: HarnessGenome, corpus: Corpus, taskId: string, seed: number): string;
/** Convenience: ground-truth and decoy counts for a corpus (fitness denominators). */
export declare function corpusCounts(corpus: Corpus): {
    groundTruth: number;
    decoys: number;
};
//# sourceMappingURL=swarm.d.ts.map