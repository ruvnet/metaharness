import type { PromotionDecision, PromotionEvidence } from '@metaharness/flywheel';
import { PROMOTION_MARGIN, promoteAuthorized } from 'radio-moe';
import type { AutogenousScore } from './score.js';

/** radio-moe mesh-evolve's frozen `PROMOTION_MARGIN`, imported rather than copied. */
export const AUTOGENOUS_PROMOTION_MARGIN: number = PROMOTION_MARGIN;

/**
 * Autogenous' domain gate: Better ∧ Safe ∧ Authorized ∧ Reversible.
 * Quality gains are conjunctive too: neither correlated nor independent cases may regress.
 */
export function autogenousPromotionRule(evidence: PromotionEvidence): PromotionDecision {
  const baseline = evidence.baseline as AutogenousScore;
  const candidate = evidence.candidate as AutogenousScore;
  const reasons: string[] = [];

  // The Better ∧ Safe ∧ Authorized ∧ Reversible core is radio-moe's own promoteAuthorized().
  const core = promoteAuthorized(candidate, baseline, {
    authorized: candidate.authorized,
    reversible: candidate.reversible,
  });
  if (!core.better) reasons.push('insufficient_separation_lift');
  if (!core.safe) reasons.push('hard_gates_failed');
  if (!core.authorized) reasons.push('not_authorized');
  if (!core.reversible) reasons.push('not_reversible');
  if (candidate.aglAdmission && !candidate.aglAdmission.admissible) {
    reasons.push(`agl_admission_refused:${candidate.aglAdmission.reason}`);
  }
  if (candidate.policyViolations.length > 0) reasons.push('policy_surface_violation');
  if (candidate.correlatedGainVsBest < 0) reasons.push('correlated_quality_below_best_single');
  if (candidate.correlatedGainVsBest < baseline.correlatedGainVsBest) {
    reasons.push('correlated_quality_regressed');
  }
  if (candidate.independentGainVsBest < baseline.independentGainVsBest) {
    reasons.push('independent_quality_regressed');
  }
  if (candidate.costPerWin > baseline.costPerWin) reasons.push('cost_worsened');
  // Unconditional, like every other check above. The previous
  // `&& reasons.length === 0` guard meant a safety regression was recorded ONLY
  // when nothing else had failed, so it vanished from `reasons` whenever any
  // other condition also tripped:
  //
  //   regressed alone            -> ['safety_regressed']
  //   regressed + cost worsened  -> ['cost_worsened']        <- safety lost
  //
  // The promote decision was correct either way (any reason blocks), but
  // `reasons` is the audit trail this gate exists to produce, and dropping the
  // most severe reason behind an incidental one misleads the operator reading it.
  if (candidate.regressed) reasons.push('safety_regressed');
  if (evidence.anchor && evidence.anchor.candidate < evidence.anchor.baseline) {
    reasons.push('anchor_regressed');
  }

  return { promote: reasons.length === 0, reasons };
}
