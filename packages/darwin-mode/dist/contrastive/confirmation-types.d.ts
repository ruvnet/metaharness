import type { HarnessDocument, JsonValue } from './types.js';
export interface ConfirmationPolicy {
    readonly minCases: number;
    readonly minWins: number;
    readonly maxRegressions: number;
    readonly minGain: number;
    readonly alpha: number;
}
export interface ConfirmationBudget {
    readonly maxUsd: number;
    readonly maxCalls: number;
    /** Total wall time for the confirmation round, not a fresh allowance per pair. */
    readonly timeoutMs: number;
    readonly pairUsd: number;
}
export interface ConfirmationPairInput {
    readonly tenantId: string;
    readonly projectId: string;
    readonly environment: JsonValue;
    readonly environmentDigest: string;
    readonly envelopeDigest: string;
    readonly envelope: JsonValue;
    readonly taskId: string;
    readonly baseline: HarnessDocument;
    readonly candidate: HarnessDocument;
    readonly baselineDigest: string;
    readonly candidateDigest: string;
    readonly signal: AbortSignal;
    readonly ceilingUsd: number;
}
export interface ConfirmationPairOutput {
    readonly tenantId: string;
    readonly projectId: string;
    readonly environmentDigest: string;
    readonly envelopeDigest: string;
    readonly taskId: string;
    readonly appliedBaselineDigest: string;
    readonly appliedCandidateDigest: string;
    readonly baselinePassed: boolean;
    readonly candidatePassed: boolean;
    readonly costUsd: number;
}
export interface ConfirmationOptions {
    readonly tenantId: string;
    readonly projectId: string;
    readonly environment: JsonValue;
    readonly envelope: JsonValue;
    readonly baseline: HarnessDocument;
    readonly candidate: HarnessDocument;
    readonly developmentTaskIds: readonly string[];
    readonly confirmationTaskIds: readonly string[];
    readonly policy: ConfirmationPolicy;
    readonly budget: ConfirmationBudget;
    readonly evaluator: {
        readonly surfaceAware: true;
        /** Trusted adapter must use the same declared conditions for both executions. */
        evaluatePair(input: ConfirmationPairInput): Promise<ConfirmationPairOutput>;
    };
}
export interface ConfirmationStats {
    readonly cases: number;
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
    readonly baselinePassed: number;
    readonly candidatePassed: number;
    /** Paired accuracy gain, (wins - losses) / completed cases. */
    readonly gain: number;
    /** Exact one-sided sign tail, rounded upward to representable binary64. */
    readonly pValue: number;
}
export interface ConfirmationReceipt {
    readonly sequence: number;
    readonly taskId: string;
    readonly status: 'success' | 'failure' | 'invalid' | 'timeout' | 'budget';
    readonly reservedUsd: number;
    /** Actual finite report, or conservative reservation when unknown. */
    readonly reportedUsd: number;
    readonly cumulativeReservedUsd: number;
    readonly cumulativeReportedUsd: number;
    readonly durationMs: number;
    /** Present only on successful paired executions. */
    readonly baselinePassed?: boolean;
    readonly candidatePassed?: boolean;
}
export interface ConfirmationResult {
    readonly verdict: 'confirmed' | 'rejected' | 'inconclusive';
    readonly reason: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly environmentDigest: string;
    readonly envelopeDigest: string;
    readonly baselineDigest: string;
    readonly candidateDigest: string;
    readonly confirmationSetDigest: string;
    readonly developmentSetDigest: string;
    readonly policy: ConfirmationPolicy;
    readonly policyDigest: string;
    readonly stats: ConfirmationStats;
    readonly receipts: readonly ConfirmationReceipt[];
    readonly calls: number;
    readonly reservedUsd: number;
    readonly reportedUsd: number;
    readonly promotion: 'not-authorized';
}
//# sourceMappingURL=confirmation-types.d.ts.map