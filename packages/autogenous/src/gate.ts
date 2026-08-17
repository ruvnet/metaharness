import type { PromotionDecision, PromotionEvidence } from '@metaharness/flywheel';
import type { AutogenousScore } from './score.js';

/** Frozen in radio-moe mesh-evolve.ts. */
export const AUTOGENOUS_PROMOTION_MARGIN = 0.02;

/**
 * Autogenous' domain gate: Better ∧ Safe ∧ Authorized ∧ Reversible.
 * Quality gains are conjunctive too: neither correlated nor independent cases may regress.
 */
export function autogenousPromotionRule(evidence: PromotionEvidence): PromotionDecision {
  const baseline = evidence.baseline as AutogenousScore;
  const candidate = evidence.candidate as AutogenousScore;
  const reasons: string[] = [];

  if (candidate.separation < baseline.separation + AUTOGENOUS_PROMOTION_MARGIN) {
    reasons.push('insufficient_separation_lift');
  }
  if (!candidate.hardGatesPass) reasons.push('hard_gates_failed');
  if (!candidate.authorized) reasons.push('not_authorized');
  if (!candidate.reversible) reasons.push('not_reversible');
  if (candidate.policyViolations.length > 0) reasons.push('policy_surface_violation');
  if (candidate.correlatedGainVsBest < 0) reasons.push('correlated_quality_below_best_single');
  if (candidate.correlatedGainVsBest < baseline.correlatedGainVsBest) {
    reasons.push('correlated_quality_regressed');
  }
  if (candidate.independentGainVsBest < baseline.independentGainVsBest) {
    reasons.push('independent_quality_regressed');
  }
  if (candidate.costPerWin > baseline.costPerWin) reasons.push('cost_worsened');
  if (candidate.regressed && reasons.length === 0) reasons.push('safety_regressed');
  if (evidence.anchor && evidence.anchor.candidate < evidence.anchor.baseline) {
    reasons.push('anchor_regressed');
  }

  return { promote: reasons.length === 0, reasons };
}
