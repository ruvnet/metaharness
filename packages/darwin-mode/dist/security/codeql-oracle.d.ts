import type { ToolAvailability, LabeledTarget } from './semgrep-oracle.js';
/** The scored result of running a query through real CodeQL on a labeled target. */
export interface CodeqlOracleResult {
    available: boolean;
    version: string;
    /** Present only on the (not-yet-implemented) success path. */
    findings?: Array<{
        path: string;
        line: number;
        ruleId: string;
    }>;
    /** A defensive receipt: why we skipped, or what failed. */
    reason?: string;
}
/** Probe whether codeql is runnable; never throws. Returns available:false when absent. */
export declare function codeqlAvailability(binary?: string): ToolAvailability;
/**
 * The real CodeQL detection oracle (Phase 2 ADAPTER SHELL). Optional — skips when
 * absent, exactly like `SemgrepDetectorOracle`. The present-path (database build +
 * `codeql database analyze`) is a documented TODO; the contract and the
 * graceful-skip behavior are the shipped surface.
 */
export declare class CodeqlDetectorOracle {
    readonly name = "codeql";
    private readonly binary;
    private readonly timeoutMs;
    constructor(opts?: {
        binary?: string;
        timeoutMs?: number;
    });
    availability(): ToolAvailability;
    isAvailable(): boolean;
    /**
     * Run a CodeQL query (pack/suite) against a labeled target and SCORE it.
     *
     * Behavior:
     *  - CodeQL ABSENT (the common case, incl. this environment): gracefully returns
     *    `{ available: false, reason }` so callers/tests skip rather than fail.
     *  - CodeQL PRESENT: structured to run `codeql database create` then
     *    `codeql database analyze --format=sarif-latest`, parse the SARIF results,
     *    and score them file-level against `target.labels` (mirroring
     *    `SemgrepDetectorOracle.evaluate`). This path is NOT yet implemented and
     *    throws — the point of this shell is the availability probe + graceful skip.
     *
     * @param query     a CodeQL query/pack/suite reference (e.g. a `.ql` path).
     * @param target    a real, on-disk labeled target.
     */
    evaluate(query: string, target: LabeledTarget): CodeqlOracleResult;
}
//# sourceMappingURL=codeql-oracle.d.ts.map