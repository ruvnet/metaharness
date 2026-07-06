// @metaharness/evals-hle — COST-AWARE 3-PASS ROUTING.
//
// Pass 1: cheap model, strict answer format, no verifier.
// Pass 2: same/mid model + subject verifier + answer normalization.
// Pass 3: frontier model — ONLY when uncertainty remains high.
// The win condition is NOT "highest score at any cost"; it is frontier-class accuracy at materially lower
// cost with better calibration. Escalation is gated by confidence + verifier disagreement + format validity.
import type { SubjectPolicy } from './genome.js';

export interface EscalationSignals {
  confidence: number;
  verifierDisagrees: boolean;
  answerFormatInvalid: boolean;
  /** Optional prior: this subject is high-error for the cheap model. */
  subjectIsHighErrorForCheap?: boolean;
  /** USD spent on this question so far — hard stop against the per-question cap. */
  costSoFarUsd: number;
}

export function shouldEscalate(policy: SubjectPolicy, sig: EscalationSignals, maxCostPerQuestionUsd: number): boolean {
  if (sig.costSoFarUsd >= maxCostPerQuestionUsd) return false; // cost cap wins — never escalate past budget
  return (
    sig.confidence < policy.escalationThreshold ||
    sig.verifierDisagrees ||
    sig.answerFormatInvalid ||
    !!sig.subjectIsHighErrorForCheap
  );
}

/** Whether to abstain: after the last affordable pass, confidence still under the abstain floor. Abstention
 *  is a COMMITTED no-op — better a null than a confident wrong answer (protects calibration + the noop gate,
 *  but too much abstention worsens the noopRate the frozen gate requires to strictly improve). */
export function shouldAbstain(policy: SubjectPolicy, finalConfidence: number): boolean {
  return finalConfidence < policy.abstainThreshold;
}

/** The three routing tiers, cheapest first. The caller maps a tier to a concrete model. */
export const TIERS = ['cheap', 'mid', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

export function nextTier(current: Tier): Tier {
  const i = TIERS.indexOf(current);
  return TIERS[Math.min(TIERS.length - 1, i + 1)];
}
