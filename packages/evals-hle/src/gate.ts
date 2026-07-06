// @metaharness/evals-hle — the HLE COMPOSITE PROMOTION GATE.
//
// CRITICAL INTEGRITY PROPERTY: the flywheel's default `meetsPromotionRule` is FROZEN and is NOT edited here.
// This gate is a STRICTER superset — it CALLS the frozen rule and ANDs the HLE-specific clauses on top. The
// flywheel supports injecting a `PromotionRule`; the replay bundle fingerprints WHATEVER rule ran, so this
// composite is itself frozen + verifiably unchanged for the HLE deployment. "The gate is the product" holds:
// a promotion is only as trustworthy as the (fingerprinted) rule that admitted it.
//
// HLE extras (all must hold, on top of every frozen clause):
//   MATERIALITY (disjunctive) — a promotion must be a MEANINGFUL win, one of:
//       accuracy win:  candidate.accuracy ≥ baseline.accuracy + 0.02   (below this is noise at N~500)
//       cost win:      accuracy held (≥ baseline) AND cost/correct ≤ 0.60 × baseline (≥40% cheaper)
//     This mirrors the acceptance test's OR ("beat by ≥3pp" OR "same score at ≥40% lower cost"). We keep the
//     GATE margin at the +2pp validation bar; the +3pp bar is the FINAL frozen-holdout ACCEPTANCE claim,
//     confirmed exactly once (see FROZEN_HOLDOUT_ACCEPTANCE below), never the per-generation gate.
//   format-error not worse     candidate.formatErrorRate ≤ baseline.formatErrorRate
//   calibration not worse      candidate.calibrationError ≤ baseline.calibrationError + 1e-9
//   ≤2 subject regressions     count(subjects where candidate acc < baseline acc) ≤ 2
// The frozen base gate ALSO guarantees, for EVERY promotion (product-mode, stricter than the acceptance
// test's cost tolerance): cost/correct never worsens, the no-commit rate STRICTLY improves (the harness must
// make the model commit more, not merely cheaper), the anchor never regresses. We deliberately do NOT admit
// the acceptance test's "cost up to 1.5x for an accuracy gain" branch — that is competition mode; the
// shipped product gate never lets cost/correct rise. Being stricter on cost is the anti-overfit-safe side.
import { meetsPromotionRule } from '@metaharness/flywheel';
import type { PromotionEvidence, PromotionDecision } from '@metaharness/flywheel';
import type { HleScore } from './score.js';

/** Per-generation VALIDATION gate margin. */
export const HLE_ACCURACY_MARGIN = 0.02;
/** A cost win must cut cost/correct by at least this fraction with no accuracy loss. */
export const HLE_COST_WIN_FRACTION = 0.4;
export const HLE_MAX_SUBJECT_REGRESSIONS = 2;
/** The FINAL claim bar, confirmed EXACTLY ONCE on the frozen holdout — NOT the per-generation gate.
 *  Public context (Artificial Analysis, pass@1, 2,158 text-only Qs): top frontier ~53%. Target claim:
 *  95–105% of top frontier at materially lower cost, and +3–6pp above the SAME model with tuned verifier +
 *  routing. A +20pp jump would signal contamination/leakage — do not claim it. */
export const FROZEN_HOLDOUT_ACCEPTANCE = {
  minAccuracyLiftPp: 0.03,
  maxCostPerCorrectRatio: 1.5,
  costWinFraction: 0.4,
} as const;

/** The composite HLE gate. `evidence.baseline`/`candidate` MUST be HleScore (they carry the extra axes). */
export function hlePromotionRule(evidence: PromotionEvidence): PromotionDecision {
  // 1) the FROZEN default gate — untouched, called verbatim.
  const base = meetsPromotionRule(evidence);
  const reasons = [...base.reasons];

  const b = evidence.baseline as HleScore;
  const c = evidence.candidate as HleScore;

  // 2) HLE extras (guard for the case a plain Score slips through).
  if (typeof c.accuracy === 'number' && typeof b.accuracy === 'number') {
    // MATERIALITY: an accuracy win OR a cost win — one must hold. (The frozen base gate already ensures
    // accuracy never regresses and cost/correct never worsens, so both branches are frozen-compatible.)
    const accuracyWin = c.accuracy >= b.accuracy + HLE_ACCURACY_MARGIN;
    const costWin = c.accuracy >= b.accuracy && c.costPerCorrect <= b.costPerCorrect * (1 - HLE_COST_WIN_FRACTION);
    if (!accuracyWin && !costWin) reasons.push('immaterial_no_accuracy_or_cost_win');
    if (c.formatErrorRate > b.formatErrorRate) reasons.push('format_error_worsened');
    if (c.calibrationError > b.calibrationError + 1e-9) reasons.push('calibration_worsened');
    const regressions = subjectRegressionCount(b, c);
    if (regressions > HLE_MAX_SUBJECT_REGRESSIONS) reasons.push(`subject_regressions_${regressions}`);
  }

  return { promote: reasons.length === 0, reasons };
}

/** Number of subjects whose accuracy dropped candidate-vs-baseline (only subjects present in both). */
export function subjectRegressionCount(baseline: HleScore, candidate: HleScore): number {
  let count = 0;
  for (const [subj, ba] of Object.entries(baseline.perSubjectAccuracy)) {
    const ca = candidate.perSubjectAccuracy[subj as keyof typeof candidate.perSubjectAccuracy];
    if (typeof ca === 'number' && typeof ba === 'number' && ca < ba) count++;
  }
  return count;
}
