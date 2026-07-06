// @metaharness/evals-sql — COST-AWARE 3-PASS ROUTING.
//
// Pass 1: cheap model, direct decoding, no verifier.
// Pass 2: same/mid model + schema-linking + execute-and-compare + SQL normalization.
// Pass 3: frontier model — ONLY when uncertainty remains high.
// The win condition is NOT "highest execution-match at any cost"; it is frontier-class accuracy at materially
// lower cost with better calibration. Escalation is gated by confidence + verifier disagreement + SQL
// validity.
import type { QueryTypePolicy } from './genome.js';

export interface EscalationSignals {
  confidence: number;
  verifierDisagrees: boolean;
  sqlInvalid: boolean;
  /** Optional prior: this query type is high-error for the cheap model. */
  queryTypeIsHardForCheap?: boolean;
  /** USD spent on this query so far — hard stop against the per-query cap. */
  costSoFarUsd: number;
}

export function shouldEscalate(policy: QueryTypePolicy, sig: EscalationSignals, maxCostPerQueryUsd: number): boolean {
  if (sig.costSoFarUsd >= maxCostPerQueryUsd) return false; // cost cap wins — never escalate past budget
  return (
    sig.confidence < policy.escalationThreshold ||
    sig.verifierDisagrees ||
    sig.sqlInvalid ||
    !!sig.queryTypeIsHardForCheap
  );
}

/** Whether to abstain: after the last affordable pass, confidence still under the abstain floor. Abstention
 *  is a COMMITTED no-op — better a null than a confident wrong query (protects calibration + the noop gate,
 *  but too much abstention worsens the noopRate the frozen gate requires to strictly improve). */
export function shouldAbstain(policy: QueryTypePolicy, finalConfidence: number): boolean {
  return finalConfidence < policy.abstainThreshold;
}

/** The three routing tiers, cheapest first. The caller maps a tier to a concrete model. */
export const TIERS = ['cheap', 'mid', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

export function nextTier(current: Tier): Tier {
  const i = TIERS.indexOf(current);
  return TIERS[Math.min(TIERS.length - 1, i + 1)];
}
