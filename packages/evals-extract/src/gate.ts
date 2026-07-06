// @metaharness/evals-extract — the EXTRACT COMPOSITE PROMOTION GATE.
//
// CRITICAL INTEGRITY PROPERTY: the flywheel's default `meetsPromotionRule` is FROZEN and is NOT edited here.
// This gate is a STRICTER superset — it CALLS the frozen rule and ANDs the extract-specific clauses on top.
// The flywheel supports injecting a `PromotionRule`; the replay bundle fingerprints WHATEVER rule ran, so
// this composite is itself frozen + verifiably unchanged for the extraction deployment. "The gate is the
// product" holds: a promotion is only as trustworthy as the (fingerprinted) rule that admitted it.
//
// Extract extras (all must hold, on top of every frozen clause):
//   MATERIALITY (disjunctive) — a promotion must be a MEANINGFUL win, one of:
//       accuracy win:  candidate.accuracy ≥ baseline.accuracy + 0.02   (below this is noise at N~500)
//       cost win:      accuracy held (≥ baseline) AND cost/correct ≤ 0.60 × baseline (≥40% cheaper)
//   schema-error not worse     candidate.schemaErrorRate ≤ baseline.schemaErrorRate
//   calibration not worse      candidate.calibrationError ≤ baseline.calibrationError + 1e-9
//   ≤2 doc-type regressions    count(doc types where candidate acc < baseline acc) ≤ 2
// The frozen base gate ALSO guarantees, for EVERY promotion: cost/correct never worsens, the no-commit rate
// (schema-invalid + abstention) STRICTLY improves (the harness must make the model emit a valid object more
// often, not merely cheaper), the anchor never regresses. We deliberately do NOT admit a "cost may rise for an
// accuracy gain" branch — the shipped product gate never lets cost/correct rise. Stricter-on-cost is the
// anti-overfit-safe side.
import { meetsPromotionRule } from '@metaharness/flywheel';
import type { PromotionEvidence, PromotionDecision } from '@metaharness/flywheel';
import type { ExtractScore } from './score.js';

/** Per-generation VALIDATION gate margin. */
export const EXTRACT_ACCURACY_MARGIN = 0.02;
/** A cost win must cut cost/correct by at least this fraction with no accuracy loss. */
export const EXTRACT_COST_WIN_FRACTION = 0.4;
export const EXTRACT_MAX_DOCTYPE_REGRESSIONS = 2;
/** The FINAL claim bar, confirmed EXACTLY ONCE on the frozen holdout — NOT the per-generation gate.
 *  Target claim: frontier-class field-accuracy at materially lower cost, and a measurable schema-error
 *  reduction over the SAME model with tuned strictness + verifier + routing. A giant jump would signal
 *  contamination/leakage — do not claim it. */
export const FROZEN_HOLDOUT_ACCEPTANCE = {
  minAccuracyLiftPp: 0.03,
  maxCostPerCorrectRatio: 1.5,
  costWinFraction: 0.4,
} as const;

/** The composite extract gate. `evidence.baseline`/`candidate` MUST be ExtractScore (they carry extra axes). */
export function extractPromotionRule(evidence: PromotionEvidence): PromotionDecision {
  // 1) the FROZEN default gate — untouched, called verbatim.
  const base = meetsPromotionRule(evidence);
  const reasons = [...base.reasons];

  const b = evidence.baseline as ExtractScore;
  const c = evidence.candidate as ExtractScore;

  // 2) extract extras (guard for the case a plain Score slips through).
  if (typeof c.accuracy === 'number' && typeof b.accuracy === 'number') {
    // MATERIALITY: an accuracy win OR a cost win — one must hold. (The frozen base gate already ensures
    // accuracy never regresses and cost/correct never worsens, so both branches are frozen-compatible.)
    const accuracyWin = c.accuracy >= b.accuracy + EXTRACT_ACCURACY_MARGIN;
    const costWin = c.accuracy >= b.accuracy && c.costPerCorrect <= b.costPerCorrect * (1 - EXTRACT_COST_WIN_FRACTION);
    if (!accuracyWin && !costWin) reasons.push('immaterial_no_accuracy_or_cost_win');
    if (c.schemaErrorRate > b.schemaErrorRate) reasons.push('schema_error_worsened');
    if (c.calibrationError > b.calibrationError + 1e-9) reasons.push('calibration_worsened');
    const regressions = docTypeRegressionCount(b, c);
    if (regressions > EXTRACT_MAX_DOCTYPE_REGRESSIONS) reasons.push(`doctype_regressions_${regressions}`);
  }

  return { promote: reasons.length === 0, reasons };
}

/** Number of doc types whose accuracy dropped candidate-vs-baseline (only doc types present in both). */
export function docTypeRegressionCount(baseline: ExtractScore, candidate: ExtractScore): number {
  let count = 0;
  for (const [dt, ba] of Object.entries(baseline.perDocTypeAccuracy)) {
    const ca = candidate.perDocTypeAccuracy[dt as keyof typeof candidate.perDocTypeAccuracy];
    if (typeof ca === 'number' && typeof ba === 'number' && ca < ba) count++;
  }
  return count;
}
