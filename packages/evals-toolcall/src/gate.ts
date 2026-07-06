// @metaharness/evals-toolcall — the TOOLCALL COMPOSITE PROMOTION GATE.
//
// CRITICAL INTEGRITY PROPERTY: the flywheel's default `meetsPromotionRule` is FROZEN and is NOT edited here.
// This gate is a STRICTER superset — it CALLS the frozen rule and ANDs the toolcall-specific clauses on top.
// The flywheel supports injecting a `PromotionRule`; the replay bundle fingerprints WHATEVER rule ran, so this
// composite is itself frozen + verifiably unchanged for the toolcall deployment. "The gate is the product"
// holds: a promotion is only as trustworthy as the (fingerprinted) rule that admitted it.
//
// Toolcall extras (all must hold, on top of every frozen clause):
//   MATERIALITY (disjunctive) — a promotion must be a MEANINGFUL win, one of:
//       accuracy win:  candidate.accuracy ≥ baseline.accuracy + 0.02   (below this is noise at N~500)
//       cost win:      accuracy held (≥ baseline) AND cost/correct ≤ 0.60 × baseline (≥40% cheaper)
//     This mirrors the acceptance test's OR ("beat by ≥3pp" OR "same score at ≥40% lower cost"). We keep the
//     GATE margin at the +2pp validation bar; the +3pp bar is the FINAL frozen-holdout ACCEPTANCE claim,
//     confirmed exactly once (see FROZEN_HOLDOUT_ACCEPTANCE below), never the per-generation gate.
//   arg-error not worse        candidate.argErrorRate ≤ baseline.argErrorRate
//   calibration not worse      candidate.calibrationError ≤ baseline.calibrationError + 1e-9
//   ≤2 category regressions    count(categories where candidate acc < baseline acc) ≤ 2
// The frozen base gate ALSO guarantees, for EVERY promotion (product-mode, stricter than the acceptance
// test's cost tolerance): cost/correct never worsens, the no-commit rate STRICTLY improves (the harness must
// make the model emit a valid call more often, not merely cheaper), the anchor never regresses. We
// deliberately do NOT admit the acceptance test's "cost up to 1.5x for an accuracy gain" branch — that is
// competition mode; the shipped product gate never lets cost/correct rise. Being stricter on cost is the
// anti-overfit-safe side.
import { meetsPromotionRule } from '@metaharness/flywheel';
import type { PromotionEvidence, PromotionDecision } from '@metaharness/flywheel';
import type { ToolcallScore } from './score.js';

/** Per-generation VALIDATION gate margin. */
export const TOOLCALL_ACCURACY_MARGIN = 0.02;
/** A cost win must cut cost/correct by at least this fraction with no accuracy loss. */
export const TOOLCALL_COST_WIN_FRACTION = 0.4;
export const TOOLCALL_MAX_CATEGORY_REGRESSIONS = 2;
/** The FINAL claim bar, confirmed EXACTLY ONCE on the frozen holdout — NOT the per-generation gate.
 *  Public context (BFCL v3 leaderboard, AST/exec accuracy): top frontier ~80% overall. Target claim:
 *  95–105% of top frontier at materially lower cost, and +3–6pp above the SAME model with tuned schema
 *  verifier + retry + routing. A +20pp jump would signal contamination/leakage — do not claim it. */
export const FROZEN_HOLDOUT_ACCEPTANCE = {
  minAccuracyLiftPp: 0.03,
  maxCostPerCorrectRatio: 1.5,
  costWinFraction: 0.4,
} as const;

/** The composite toolcall gate. `evidence.baseline`/`candidate` MUST be ToolcallScore (extra axes). */
export function toolcallPromotionRule(evidence: PromotionEvidence): PromotionDecision {
  // 1) the FROZEN default gate — untouched, called verbatim.
  const base = meetsPromotionRule(evidence);
  const reasons = [...base.reasons];

  const b = evidence.baseline as ToolcallScore;
  const c = evidence.candidate as ToolcallScore;

  // 2) toolcall extras (guard for the case a plain Score slips through).
  if (typeof c.accuracy === 'number' && typeof b.accuracy === 'number') {
    // MATERIALITY: an accuracy win OR a cost win — one must hold. (The frozen base gate already ensures
    // accuracy never regresses and cost/correct never worsens, so both branches are frozen-compatible.)
    const accuracyWin = c.accuracy >= b.accuracy + TOOLCALL_ACCURACY_MARGIN;
    const costWin = c.accuracy >= b.accuracy && c.costPerCorrect <= b.costPerCorrect * (1 - TOOLCALL_COST_WIN_FRACTION);
    if (!accuracyWin && !costWin) reasons.push('immaterial_no_accuracy_or_cost_win');
    if (c.argErrorRate > b.argErrorRate) reasons.push('arg_error_worsened');
    if (c.calibrationError > b.calibrationError + 1e-9) reasons.push('calibration_worsened');
    const regressions = categoryRegressionCount(b, c);
    if (regressions > TOOLCALL_MAX_CATEGORY_REGRESSIONS) reasons.push(`category_regressions_${regressions}`);
  }

  return { promote: reasons.length === 0, reasons };
}

/** Number of categories whose accuracy dropped candidate-vs-baseline (only categories present in both). */
export function categoryRegressionCount(baseline: ToolcallScore, candidate: ToolcallScore): number {
  let count = 0;
  for (const [cat, ba] of Object.entries(baseline.perCategoryAccuracy)) {
    const ca = candidate.perCategoryAccuracy[cat as keyof typeof candidate.perCategoryAccuracy];
    if (typeof ca === 'number' && typeof ba === 'number' && ca < ba) count++;
  }
  return count;
}
