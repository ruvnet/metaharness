import type { Corpus } from './corpus.js';
/** Measured false-positive repeat-rate drop from negative memory (ADR-155). */
export declare function falsePositiveRepeatDrop(): {
    cold: number;
    warm: number;
    drop: number;
};
/** Measured patch-reuse success from patch memory (ADR-155). */
export declare function patchReuseSuccess(seedCorpus: Corpus): {
    withMemory: number;
    withoutMemory: number;
    improvement: number;
};
/** Measured advantage of genome-seeded vs random populations (ADR-155). */
export declare function seededVsRandom(corpus: Corpus, baselineFalsePositiveRate: number, seed?: number): {
    seededMean: number;
    randomMean: number;
    advantage: number;
};
/** The full compounding report against the ADR-155 acceptance thresholds. */
export interface CompoundingReport {
    fpRepeatDrop: {
        cold: number;
        warm: number;
        drop: number;
        pass: boolean;
    };
    patchReuse: {
        withMemory: number;
        withoutMemory: number;
        improvement: number;
        pass: boolean;
    };
    seededVsRandom: {
        seededMean: number;
        randomMean: number;
        advantage: number;
        pass: boolean;
    };
    passed: boolean;
}
export declare function measureCompounding(corpus: Corpus, baselineFalsePositiveRate?: number, seed?: number): CompoundingReport;
//# sourceMappingURL=compounding.d.ts.map