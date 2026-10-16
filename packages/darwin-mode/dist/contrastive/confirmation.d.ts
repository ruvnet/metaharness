import type { ConfirmationOptions, ConfirmationResult } from './confirmation-types.js';
export * from './confirmation-types.js';
/**
 * Exact one-sided sign/McNemar binomial tail. BigInt summation avoids
 * cancellation; the final double is conservatively rounded upward.
 * Extremely small probabilities return Number.MIN_VALUE, never false zero.
 */
export declare function pairedSignPValue(wins: number, losses: number): number;
/**
 * Independent fixed-set confirmation, never production promotion.
 * Adapters must execute BOTH documents under equal declared conditions and
 * enforce ceilingUsd/cancellation at the actual effect boundary. Digests are
 * trusted adapter attestations, not cryptographic proof of execution.
 * Task IDs cannot prove underlying dataset isolation or prevent repeated tests.
 */
export declare function confirmContrastive(options: ConfirmationOptions): Promise<ConfirmationResult>;
//# sourceMappingURL=confirmation.d.ts.map