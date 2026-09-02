import { type BootstrapResult } from './stats.js';
import { SemgrepDetectorOracle, type LabeledTarget } from './semgrep-oracle.js';
/** A weakness pattern the generator can synthesize a real Semgrep rule for. */
export type RulePatternKey = 'eval' | 'exec' | 'shell-true' | 'yaml-load' | 'pickle-loads' | 'os-system' | 'weak-hash' | 'mktemp';
/** Synthesize a real Semgrep rule YAML covering the given weakness patterns. */
export declare function generateSemgrepRule(keys: RulePatternKey[]): string;
/**
 * Per-file score for a rule against a labeled corpus, judged by real Semgrep.
 * vulnerable file ⇒ 1 if detected else 0 (recall); clean/decoy file ⇒ 1 if NOT
 * detected else 0 (precision). One score per labeled file = the bootstrap sample.
 */
export declare function perFileScores(oracle: SemgrepDetectorOracle, ruleYaml: string, corpus: LabeledTarget): {
    scores: number[];
    falsePositives: number;
    detected: string[];
};
export interface RealCandidateGate {
    name: string;
    pass: boolean;
    detail: string;
}
export interface RealCandidateVerdict {
    available: boolean;
    promote: boolean;
    version: string;
    gates: RealCandidateGate[];
    bootstrap: BootstrapResult;
    incumbentScore: number;
    candidateScore: number;
    candidateFalsePositives: number;
    receiptHash: string;
    reason?: string;
}
/**
 * Judge a candidate rule against the incumbent using REAL Semgrep as the oracle
 * and the existing paired-bootstrap promotion gate. Gracefully returns
 * `available:false` when semgrep is absent (caller skips). Deterministic for a
 * fixed semgrep version + seed.
 */
export declare function evaluateRealCandidate(incumbent: RulePatternKey[], candidate: RulePatternKey[], corpus: LabeledTarget, opts?: {
    oracle?: SemgrepDetectorOracle;
    seed?: number;
}): RealCandidateVerdict;
//# sourceMappingURL=real-loop.d.ts.map