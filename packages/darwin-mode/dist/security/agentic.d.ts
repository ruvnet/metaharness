import type { Corpus } from './corpus.js';
import type { Finding } from './types.js';
import { type FuzzOracle } from './invariant.js';
/** The restricted, gated tool surface (all read-only or oracle-only). */
export type AgenticToolName = 'list_sites' | 'read_site' | 'grep' | 'run_analyzer' | 'run_fuzzer' | 'assert_invariant' | 'submit_finding';
/** Tools the loop may NEVER have (proof the surface is bounded). */
export declare const FORBIDDEN_TOOLS: readonly string[];
/** The evolvable loop policy (ADR-153: the surfaces become the loop's policy). */
export interface AgenticPolicy {
    /** Hard cap on total tool-steps (bounds the loop — no runaway). */
    maxSteps: number;
    /** Use the fuzzer/invariant-falsification path (zero-FP confirmation). */
    useFuzzer: boolean;
    /** Use the static analyzer path (shallow, single-shot-equivalent). */
    useAnalyzer: boolean;
    /** Exploration order over sites. */
    planner: 'sink-first' | 'risk-first' | 'callgraph-first' | 'file-first';
    /** Per-invariant fuzz budget (seconds) when the fuzzer is used. */
    fuzzBudgetSeconds: number;
}
export declare function defaultAgenticPolicy(): AgenticPolicy;
/** A single recorded step in the loop's trace (the audit trail / receipt). */
export interface AgenticStep {
    step: number;
    tool: AgenticToolName;
    target: string;
    result: string;
}
export interface AgenticRunResult {
    findings: Finding[];
    trace: AgenticStep[];
    stepsUsed: number;
    metrics: {
        truePositives: number;
        falsePositives: number;
        falseNegatives: number;
        unsafeOutputs: number;
    };
    /** Tamper-evident hash over (policy, corpus, trace). */
    receiptHash: string;
}
/** Run the bounded agentic discovery loop over a corpus. Deterministic + gated. */
export declare function runAgenticLoop(corpus: Corpus, policy?: AgenticPolicy, fuzz?: FuzzOracle): AgenticRunResult;
/**
 * The single-shot baseline (the exhausted paradigm): no navigation, analyzer
 * only, so a vuln with discoveryDepth > 1 is structurally invisible. This is what
 * the agentic loop is measured against — the discovery wall.
 */
export declare function runSingleShot(corpus: Corpus): {
    truePositives: number;
    falseNegatives: number;
    tpr: number;
};
/**
 * A discovery corpus: most vulns require multi-step navigation (depth 2-3) to
 * surface — the regime where single-shot fails and the agentic loop wins. Decoys
 * are present so the zero-false-positive (counterexample-required) property holds.
 */
export declare function discoveryCorpus(): Corpus;
//# sourceMappingURL=agentic.d.ts.map