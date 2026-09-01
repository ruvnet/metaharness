import type { Corpus } from './corpus.js';
/** The allowlisted editable surfaces (ADR-155 Addendum §Decision). */
export type ShieldSurface = 'semgrep-rule' | 'codeql-snippet' | 'taint-heuristic' | 'reviewer-prompt' | 'detector-config' | 'adapter-normalizer';
export declare const EDITABLE_SURFACES: readonly ShieldSurface[];
/**
 * Forbidden generation targets — the referee. A generated artifact that names any
 * of these in a write/modify/import context is rejected outright (ADR-155
 * Addendum §Forbidden generated artifacts). The safety machinery is never an
 * evolutionary surface.
 */
export declare const FORBIDDEN_TARGETS: readonly string[];
/** True iff a surface is on the Phase-1 allowlist. */
export declare function isEditableSurface(surface: string): surface is ShieldSurface;
/**
 * Static validation of a generated detector artifact BEFORE it is trusted
 * (ADR-155 Addendum §Promotion gate 7-9). Returns violations; empty ⇒ admissible.
 * Independent of the oracle (defense in depth): a candidate that fails here is
 * archived but never promoted.
 */
export declare function validateGeneratedShieldCode(surface: string, artifact: string): string[];
/** A parsed detector rule (the inspectable, auditable form an artifact encodes). */
export interface DetectorRule {
    /** Weakness classes the rule covers (matched against corpus site weaknesses). */
    covers: string[];
    /** 0..1 precision — higher rejects more decoys (fewer false positives). */
    precision: number;
}
/**
 * Parse a generated artifact into a rule. Format is a tiny, dependency-free,
 * inspectable text block (no eval, no YAML dep):
 *   covers: CWE-89, CWE-79
 *   precision: 0.9
 */
export declare function parseDetector(artifact: string): DetectorRule;
/** The full, replayable receipt for a generated candidate (§Determinism contract). */
export interface ShieldGenReceipt {
    prompt: string;
    model: string;
    seed: number;
    artifact: string;
    formatterOutput: string;
    validatorOutput: string[];
    testOutput: string;
    corpusVersion: string;
    toolVersions: Record<string, string>;
    receiptHash: string;
}
/** A generated detector candidate (artifact + provenance), pre-evaluation. */
export interface GeneratedDetectorCandidate {
    id: string;
    surface: ShieldSurface;
    artifact: string;
    prompt: string;
    model: string;
    seed: number;
}
/** The generator hook. The deterministic mock is the Phase-1 default. */
export interface ShieldCodeGenerator {
    generateDetector(input: {
        surface: ShieldSurface;
        /** Target weakness classes / repo context to cover. */
        targets: string[];
        seed?: number;
    }): GeneratedDetectorCandidate;
}
/**
 * A deterministic, dependency-free stand-in for an LLM detector generator: emits
 * a rule covering the requested targets with a precision derived from the seed.
 * Reproducible (same input ⇒ identical artifact), so Phase 1 has full replay.
 */
export declare class DeterministicDetectorGenerator implements ShieldCodeGenerator {
    readonly model = "deterministic-mock";
    generateDetector(input: {
        surface: ShieldSurface;
        targets: string[];
        seed?: number;
    }): GeneratedDetectorCandidate;
}
/** A detector oracle: run a rule over a corpus and report findings vs labels. */
export interface DetectorOracle {
    readonly name: string;
    readonly version: string;
    /** Per-repo (truePositives, falsePositives, ...) for the rule. */
    evaluate(rule: DetectorRule, corpus: Corpus): Array<{
        repo: string;
        tp: number;
        fp: number;
        fn: number;
        vulns: number;
        decoys: number;
    }>;
}
/**
 * A deterministic MOCK oracle (Phase 1). A vulnerable site is a true positive
 * when the rule covers its weakness; a decoy leaks as a false positive when the
 * rule's precision is below the decoy's resistance threshold. No real Semgrep —
 * Phase 2 implements the same interface against `semgrep --json`.
 */
export declare class MockDetectorOracle implements DetectorOracle {
    readonly name = "mock-detector-oracle";
    readonly version = "1.0.0";
    evaluate(rule: DetectorRule, corpus: Corpus): {
        repo: string;
        tp: number;
        fp: number;
        fn: number;
        vulns: number;
        decoys: number;
    }[];
}
/** Build the full determinism-contract receipt for a candidate + oracle run. */
export declare function captureReceipt(candidate: GeneratedDetectorCandidate, validatorOutput: string[], testOutput: string, corpus: Corpus, oracle: DetectorOracle): ShieldGenReceipt;
/** One gate result in the candidate promotion decision. */
export interface CandidateGate {
    name: string;
    pass: boolean;
    detail: string;
}
/** The full promotion verdict for a generated candidate (ADR-155 Addendum). */
export interface CandidateVerdict {
    candidate: GeneratedDetectorCandidate;
    receipt: ShieldGenReceipt;
    gates: CandidateGate[];
    promote: boolean;
}
export interface EvaluateOptions {
    /** Easy corpus (saturation check) and hard corpus (real frontier). */
    easyCorpus: Corpus;
    hardCorpus: Corpus;
    baselineFpRate?: number;
    /** Max allowed FP-rate regression vs the incumbent (default 0). */
    fpRegressionThreshold?: number;
    /** Runtime budget in oracle-evaluations (default 64). */
    runtimeBudget?: number;
    seed?: number;
}
/**
 * Evaluate a generated candidate against the incumbent detector through ALL ten
 * promotion gates (ADR-155 Addendum §Promotion gate). A candidate replaces the
 * incumbent only if every gate passes; otherwise it is archived (receipt kept),
 * never promoted. Deterministic and replayable.
 */
export declare function evaluateCandidate(incumbent: DetectorRule, candidate: GeneratedDetectorCandidate, oracle: DetectorOracle, opts: EvaluateOptions): CandidateVerdict;
/**
 * Phase-1 end-to-end flow: generate → validate → oracle → receipt → gate.
 * OPT-IN: nothing in the default Shield evolve/benchmark path calls this. The
 * deterministic config mutator remains the default search; this is the bounded
 * self-writing extension, invoked only when a caller explicitly opts in.
 */
export declare function synthesizeAndEvaluate(generator: ShieldCodeGenerator, surface: ShieldSurface, targets: string[], incumbent: DetectorRule, oracle: DetectorOracle, opts: EvaluateOptions): CandidateVerdict;
//# sourceMappingURL=selfwrite.d.ts.map