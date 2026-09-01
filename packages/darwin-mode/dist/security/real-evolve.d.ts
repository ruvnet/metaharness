import { type BootstrapResult } from './stats.js';
import { SemgrepDetectorOracle, type LabeledTarget } from './semgrep-oracle.js';
import { type RulePatternKey } from './real-loop.js';
/** The default weakness vocabulary the detector population draws from. */
export declare const ALL_PATTERNS: RulePatternKey[];
/** The full weakness vocabulary, including command/crypto/temp-file classes. */
export declare const FULL_VOCABULARY: RulePatternKey[];
/** A detector genome: a set of weakness patterns the harness chose to cover. */
export interface DetectorGenome {
    id: string;
    parentId?: string;
    patterns: RulePatternKey[];
}
export interface ScoredDetector {
    genome: DetectorGenome;
    perFile: number[];
    mean: number;
    falsePositives: number;
}
export interface RealEvolveResult {
    available: boolean;
    version: string;
    champion: {
        patterns: RulePatternKey[];
        mean: number;
        falsePositives: number;
    };
    baseline: {
        patterns: RulePatternKey[];
        mean: number;
        falsePositives: number;
    };
    /** Best champion fitness per generation (the learning curve). */
    history: number[];
    /** Champion lineage (genome ids, baseline → champion). */
    lineage: string[];
    generations: number;
    evaluations: number;
    /** Real semgrep oracle calls actually made (≤ evaluations, thanks to caching). */
    oracleCalls: number;
    bootstrapVsBaseline: BootstrapResult;
    promotedOverBaseline: boolean;
    receiptHash: string;
    reason?: string;
}
export interface RealEvolveConfig {
    corpus: LabeledTarget;
    generations?: number;
    population?: number;
    seed?: number;
    /** Starting rule-set (default: a deliberately weak eval-only detector). */
    baseline?: RulePatternKey[];
    eliteFraction?: number;
    oracle?: SemgrepDetectorOracle;
    /** Weakness vocabulary to evolve over (default ALL_PATTERNS). */
    vocabulary?: RulePatternKey[];
}
/**
 * Evolve a detector population with REAL Semgrep as the fitness oracle. Returns
 * the champion, learning curve, lineage, and a bootstrap certification vs the
 * baseline. Gracefully returns `available:false` when semgrep is absent.
 */
export declare function evolveDetectorsReal(cfg: RealEvolveConfig): RealEvolveResult;
//# sourceMappingURL=real-evolve.d.ts.map