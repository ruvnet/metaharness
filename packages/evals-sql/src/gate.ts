// @metaharness/evals-sql — the TEXT-TO-SQL COMPOSITE PROMOTION GATE.
//
// CRITICAL INTEGRITY PROPERTY: the flywheel's default `meetsPromotionRule` is FROZEN and is NOT edited here.
// This gate is a STRICTER superset — it CALLS the frozen rule and ANDs the SQL-specific clauses on top. The
// flywheel supports injecting a `PromotionRule`; the replay bundle fingerprints WHATEVER rule ran, so this
// composite is itself frozen + verifiably unchanged for the SQL deployment. "The gate is the product" holds:
// a promotion is only as trustworthy as the (fingerprinted) rule that admitted it.
//
// SQL extras (all must hold, on top of every frozen clause):
//   MATERIALITY (disjunctive) — a promotion must be a MEANINGFUL win, one of:
//       accuracy win:  candidate.accuracy ≥ baseline.accuracy + 0.02   (below this is noise at N~500)
//       cost win:      accuracy held (≥ baseline) AND cost/correct ≤ 0.60 × baseline (≥40% cheaper)
//     This mirrors the acceptance test's OR ("beat by ≥3pp" OR "same score at ≥40% lower cost"). We keep the
//     GATE margin at the +2pp validation bar; the +3pp bar is the FINAL frozen-holdout ACCEPTANCE claim,
//     confirmed exactly once (see FROZEN_HOLDOUT_ACCEPTANCE below), never the per-generation gate.
//   invalid-SQL not worse      candidate.invalidSqlRate ≤ baseline.invalidSqlRate
//   calibration not worse      candidate.calibrationError ≤ baseline.calibrationError + 1e-9
//   ≤2 query-type regressions  count(types where candidate acc < baseline acc) ≤ 2
// The frozen base gate ALSO guarantees, for EVERY promotion (product-mode, stricter than the acceptance
// test's cost tolerance): cost/correct never worsens, the no-commit rate STRICTLY improves (the harness must
// make the model produce a valid, committed query more often — not merely cheaper), the anchor never
// regresses. We deliberately do NOT admit the acceptance test's "cost up to 1.5x for an accuracy gain"
// branch — that is competition mode; the shipped product gate never lets cost/correct rise. Being stricter
// on cost is the anti-overfit-safe side.
import { meetsPromotionRule } from '@metaharness/flywheel';
import type { PromotionEvidence, PromotionDecision } from '@metaharness/flywheel';
import type { SqlScore } from './score.js';

/** Per-generation VALIDATION gate margin. */
export const SQL_ACCURACY_MARGIN = 0.02;
/** A cost win must cut cost/correct by at least this fraction with no accuracy loss. */
export const SQL_COST_WIN_FRACTION = 0.4;
export const SQL_MAX_TYPE_REGRESSIONS = 2;
/** The FINAL claim bar, confirmed EXACTLY ONCE on the frozen holdout — NOT the per-generation gate.
 *  Public context (Spider dev execution-match, single-model text-to-SQL): strong specialized systems sit in
 *  the ~85–90% band. Target claim: match a frontier model's zero-shot execution-match at materially lower
 *  cost, and +3–6pp above the SAME model with tuned schema-linking + execute-and-compare verification. A
 *  +20pp jump would signal contamination/leakage — do not claim it. */
export const FROZEN_HOLDOUT_ACCEPTANCE = {
  minAccuracyLiftPp: 0.03,
  maxCostPerCorrectRatio: 1.5,
  costWinFraction: 0.4,
} as const;

/** The composite SQL gate. `evidence.baseline`/`candidate` MUST be SqlScore (they carry the extra axes). */
export function sqlPromotionRule(evidence: PromotionEvidence): PromotionDecision {
  // 1) the FROZEN default gate — untouched, called verbatim.
  const base = meetsPromotionRule(evidence);
  const reasons = [...base.reasons];

  const b = evidence.baseline as SqlScore;
  const c = evidence.candidate as SqlScore;

  // 2) SQL extras (guard for the case a plain Score slips through).
  if (typeof c.accuracy === 'number' && typeof b.accuracy === 'number') {
    // MATERIALITY: an accuracy win OR a cost win — one must hold. (The frozen base gate already ensures
    // accuracy never regresses and cost/correct never worsens, so both branches are frozen-compatible.)
    const accuracyWin = c.accuracy >= b.accuracy + SQL_ACCURACY_MARGIN;
    const costWin = c.accuracy >= b.accuracy && c.costPerCorrect <= b.costPerCorrect * (1 - SQL_COST_WIN_FRACTION);
    if (!accuracyWin && !costWin) reasons.push('immaterial_no_accuracy_or_cost_win');
    if (c.invalidSqlRate > b.invalidSqlRate) reasons.push('invalid_sql_worsened');
    if (c.calibrationError > b.calibrationError + 1e-9) reasons.push('calibration_worsened');
    const regressions = typeRegressionCount(b, c);
    if (regressions > SQL_MAX_TYPE_REGRESSIONS) reasons.push(`type_regressions_${regressions}`);
  }

  return { promote: reasons.length === 0, reasons };
}

/** Number of query types whose accuracy dropped candidate-vs-baseline (only types present in both). */
export function typeRegressionCount(baseline: SqlScore, candidate: SqlScore): number {
  let count = 0;
  for (const [type, ba] of Object.entries(baseline.perTypeAccuracy)) {
    const ca = candidate.perTypeAccuracy[type as keyof typeof candidate.perTypeAccuracy];
    if (typeof ca === 'number' && typeof ba === 'number' && ca < ba) count++;
  }
  return count;
}
