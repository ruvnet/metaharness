// @metaharness/evals-toolcall — COST-AWARE 3-PASS ROUTING (with in-tier retry).
//
// Pass 1: cheap model, strict schema, no verifier.
// Pass 2: same/mid model + schema verifier + arg normalization.
// Pass 3: frontier model — ONLY when uncertainty remains high.
// Within a tier, a MALFORMED call may be retried up to `maxRetries` (the retry-policy lever) before spending
// on escalation. The win condition is NOT "highest score at any cost"; it is frontier-class call accuracy at
// materially lower cost with better calibration. Escalation is gated by confidence + verifier disagreement +
// call validity.
import type { CategoryPolicy } from './genome.js';

export interface EscalationSignals {
  confidence: number;
  verifierDisagrees: boolean;
  callFormatInvalid: boolean;
  /** Optional prior: this category is high-error for the cheap model. */
  categoryIsHighErrorForCheap?: boolean;
  /** USD spent on this query so far — hard stop against the per-call cap. */
  costSoFarUsd: number;
}

export function shouldEscalate(policy: CategoryPolicy, sig: EscalationSignals, maxCostPerCallUsd: number): boolean {
  if (sig.costSoFarUsd >= maxCostPerCallUsd) return false; // cost cap wins — never escalate past budget
  return (
    sig.confidence < policy.escalationThreshold ||
    sig.verifierDisagrees ||
    sig.callFormatInvalid ||
    !!sig.categoryIsHighErrorForCheap
  );
}

/** Whether to retry the SAME tier before escalating: the call was malformed AND we have retries left AND
 *  budget remains. A cheap same-tier re-sample is preferred to a costly tier bump for a transient malformed
 *  call (the retry-policy lever tunes how many). */
export function shouldRetry(policy: CategoryPolicy, retriesUsed: number, callFormatInvalid: boolean, costSoFarUsd: number, maxCostPerCallUsd: number): boolean {
  return callFormatInvalid && retriesUsed < policy.maxRetries && costSoFarUsd < maxCostPerCallUsd;
}

/** Whether to abstain: after the last affordable pass, confidence still under the abstain floor. Abstention
 *  is a COMMITTED no-op — better a null than a confident wrong call (protects calibration + the noop gate,
 *  but too much abstention worsens the noopRate the frozen gate requires to strictly improve). */
export function shouldAbstain(policy: CategoryPolicy, finalConfidence: number): boolean {
  return finalConfidence < policy.abstainThreshold;
}

/** The three routing tiers, cheapest first. The caller maps a tier to a concrete model. */
export const TIERS = ['cheap', 'mid', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

export function nextTier(current: Tier): Tier {
  const i = TIERS.indexOf(current);
  return TIERS[Math.min(TIERS.length - 1, i + 1)];
}
