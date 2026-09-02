/** Availability probe result for a real external tool. */
export interface ToolAvailability {
    available: boolean;
    version: string;
    binary: string;
    reason?: string;
}
/** A label: is this file (a known vulnerability) or a decoy/clean file? */
export interface TargetLabel {
    file: string;
    vulnerable: boolean;
    weakness: string;
}
/** A real, on-disk labeled target (the real-CVE-corpus shape). */
export interface LabeledTarget {
    dir: string;
    labels: TargetLabel[];
}
/** One normalized Semgrep finding (stable across runs of a fixed version). */
export interface SemgrepFinding {
    path: string;
    line: number;
    ruleId: string;
}
/** The scored result of running a rule through real Semgrep on a labeled target. */
export interface RealOracleResult {
    available: boolean;
    version: string;
    findings: SemgrepFinding[];
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    /** A defensive receipt (tool version + counts), for #39-grade auditability. */
    reason?: string;
}
/** Probe whether semgrep is runnable; never throws. */
export declare function semgrepAvailability(binary?: string): ToolAvailability;
/** The real Semgrep detection oracle (Phase 2). Optional — skips when absent. */
export declare class SemgrepDetectorOracle {
    readonly name = "semgrep";
    private readonly binary;
    private readonly timeoutMs;
    constructor(opts?: {
        binary?: string;
        timeoutMs?: number;
    });
    availability(): ToolAvailability;
    isAvailable(): boolean;
    /**
     * Run a generated rule (YAML) through real semgrep against a directory.
     * Returns normalized, sorted findings. Throws only if semgrep is present but
     * the invocation itself fails unexpectedly; callers should gate on isAvailable.
     */
    run(ruleYaml: string, targetDir: string): SemgrepFinding[];
    /**
     * Run the rule and SCORE it against the target's labels (file-level matching,
     * robust to line drift). Gracefully returns `available: false` when semgrep is
     * absent — the caller (test/bench) then skips rather than failing.
     */
    evaluate(ruleYaml: string, target: LabeledTarget): RealOracleResult;
}
//# sourceMappingURL=semgrep-oracle.d.ts.map