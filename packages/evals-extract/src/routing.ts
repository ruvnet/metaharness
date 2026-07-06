// @metaharness/evals-extract — COST-AWARE 3-PASS ROUTING.
//
// Pass 1: cheap model, direct-json extraction, no verifier.
// Pass 2: same/mid model + schema verifier + field normalization.
// Pass 3: frontier model — ONLY when uncertainty remains high.
// The win condition is NOT "highest field-accuracy at any cost"; it is frontier-class extraction accuracy at
// materially lower cost with better calibration. Escalation is gated by confidence + verifier disagreement +
// schema validity.
import type { DocTypePolicy } from './genome.js';

export interface EscalationSignals {
  confidence: number;
  verifierDisagrees: boolean;
  schemaInvalid: boolean;
  /** Optional prior: this doc type is high-error for the cheap model. */
  docTypeIsHighErrorForCheap?: boolean;
  /** USD spent on this document so far — hard stop against the per-doc cap. */
  costSoFarUsd: number;
}

export function shouldEscalate(policy: DocTypePolicy, sig: EscalationSignals, maxCostPerDocUsd: number): boolean {
  if (sig.costSoFarUsd >= maxCostPerDocUsd) return false; // cost cap wins — never escalate past budget
  return (
    sig.confidence < policy.escalationThreshold ||
    sig.verifierDisagrees ||
    sig.schemaInvalid ||
    !!sig.docTypeIsHighErrorForCheap
  );
}

/** Whether to abstain: after the last affordable pass, confidence still under the abstain floor. Abstention
 *  is a COMMITTED no-op — better a null than a confident schema-invalid object (protects calibration + the
 *  noop gate, but too much abstention worsens the noopRate the frozen gate requires to strictly improve). */
export function shouldAbstain(policy: DocTypePolicy, finalConfidence: number): boolean {
  return finalConfidence < policy.abstainThreshold;
}

/** The three routing tiers, cheapest first. The caller maps a tier to a concrete model. */
export const TIERS = ['cheap', 'mid', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

export function nextTier(current: Tier): Tier {
  const i = TIERS.indexOf(current);
  return TIERS[Math.min(TIERS.length - 1, i + 1)];
}
