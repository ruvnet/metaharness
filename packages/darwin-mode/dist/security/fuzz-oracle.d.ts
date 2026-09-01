import type { ToolAvailability } from './semgrep-oracle.js';
/** Probe whether python3 is runnable; never throws. */
export declare function pythonAvailability(bin?: string): ToolAvailability;
/** The result of fuzzing a single target. */
export interface FuzzResult {
    available: boolean;
    falsified: boolean;
    /** Exception class of the counterexample (never the input). */
    exceptionClass: string | null;
    iterations: number;
    reason?: string;
}
/** A labeled fuzz corpus: a driver + targets with vulnerability labels. */
export interface FuzzCorpus {
    dir: string;
    /** Path to the seeded fuzz driver (relative to dir or absolute). */
    driver: string;
    labels: Array<{
        file: string;
        vulnerable: boolean;
        weakness: string;
    }>;
}
/** The scored result of fuzzing a whole labeled corpus. */
export interface FuzzCorpusResult {
    available: boolean;
    version: string;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    /** Per-target falsification outcomes (for the receipt). */
    outcomes: Array<{
        file: string;
        vulnerable: boolean;
        falsified: boolean;
        exceptionClass: string | null;
    }>;
    reason?: string;
}
/** The real property/totality fuzzer (Phase 2). Optional — skips when absent. */
export declare class RealFuzzOracle {
    readonly name = "python-property-fuzzer";
    private readonly python;
    private readonly timeoutMs;
    constructor(opts?: {
        python?: string;
        timeoutMs?: number;
    });
    availability(): ToolAvailability;
    isAvailable(): boolean;
    /** Fuzz one target file with the driver; deterministic for a fixed seed. */
    fuzz(driverPath: string, targetPath: string, opts?: {
        seed?: number;
        iterations?: number;
    }): FuzzResult;
    /**
     * Run the driver against a single target assuming python is already known
     * available (no re-probe). On a hard failure (python crash, non-zero exit,
     * unparseable output) this degrades to a non-falsification result with a
     * `reason` rather than throwing — a present-but-crashing python must not
     * propagate out of `evaluate()`.
     */
    private fuzzWithBinary;
    /**
     * Fuzz every target in a labeled corpus and score the totality invariant. A
     * vulnerable target that gets falsified is a true positive; a clean target that
     * gets falsified is a false positive; a vulnerable target that holds is a false
     * negative. Gracefully returns `available:false` when python is absent.
     */
    evaluate(corpus: FuzzCorpus, opts?: {
        seed?: number;
        iterations?: number;
    }): FuzzCorpusResult;
}
/** Convenience: the path a `FuzzCorpus` finding refers to, relative to the corpus. */
export declare function relForCorpus(corpus: FuzzCorpus, abs: string): string;
//# sourceMappingURL=fuzz-oracle.d.ts.map