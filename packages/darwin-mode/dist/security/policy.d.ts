import type { Finding, ScopeAssertion } from './types.js';
/**
 * Content patterns that mark a string as a weaponized/offensive payload. If any
 * matches, the output is unsafe: it is redacted before emission and the run's
 * unsafe-output counter increments (a −1.00 fitness term — immediate rejection).
 *
 * Intentionally broad. A defensive finding describes WHERE a weakness is and HOW
 * to fix it; it never ships a runnable exploit, reverse shell, dropper, or
 * persistence/evasion mechanism.
 */
export declare const UNSAFE_OUTPUT_PATTERNS: ReadonlyArray<{
    re: RegExp;
    reason: string;
}>;
/** A scope assertion is valid iff the repo is explicitly owned or authorized. */
export declare function assertScope(scope: ScopeAssertion): {
    ok: boolean;
    reason: string;
};
/** Throwing form of {@link assertScope} for guard-clause call sites. */
export declare function requireScope(scope: ScopeAssertion): void;
/** Find every unsafe pattern present in a string (deduplicated reasons). */
export declare function detectUnsafe(text: string): string[];
/** True iff a string carries no weaponized content. */
export declare function isSafeOutput(text: string): boolean;
/**
 * Redact a string for emission. Returns the sanitized text plus the reasons it
 * was flagged (empty ⇒ already safe). Matched spans are replaced with a marker
 * so the advisory remains readable without shipping the payload.
 */
export declare function redactUnsafeOutput(text: string): {
    safe: string;
    reasons: string[];
};
/** The verdict of gating a single finding. */
export interface FindingGate {
    /** The (possibly redacted) finding, or null if it must be dropped entirely. */
    finding: Finding | null;
    unsafe: boolean;
    reasons: string[];
}
/**
 * Gate a single finding. Strategy: redact evidence/patch/advisory text in place;
 * if anything had to be redacted the finding is marked unsafe (counts toward the
 * −1.00 fitness term) but the SANITIZED finding is still returned so the run can
 * report "we found a weakness here" without ever emitting the payload. A finding
 * that (impossibly) carries `exploitCodeAllowed !== false` is dropped outright.
 */
export declare function gateFinding(finding: Finding): FindingGate;
/** The verdict of gating a whole run's outputs. */
export interface OutputGate {
    /** The sanitized, admissible findings. */
    safe: Finding[];
    /** Number of findings that contained unsafe content (the acceptance counter). */
    unsafeOutputs: number;
    /** Every unsafe reason observed, for the audit receipt. */
    reasons: string[];
}
/**
 * Batch gate over a run's findings (the "safety-redactor" agent). For ADR-155
 * acceptance, a run passes only when `unsafeOutputs === 0`. Because Darwin Shield
 * never generates exploit code, that count is structurally 0 in normal operation;
 * this gate is the proof, and the catch for any regression.
 */
export declare function gateOutputs(findings: Finding[]): OutputGate;
//# sourceMappingURL=policy.d.ts.map