// @metaharness/flywheel — the DEFAULT promotion gate + its fingerprint.
//
// "The gate is the product." A promotion is only as trustworthy as the rule that admitted it, and that
// rule must be FROZEN for a deployment and VERIFIABLY unchanged. This is the default conjunctive rule
// (every clause load-bearing; ALL must hold) — but it is just a `PromotionRule`, so a caller may inject
// its own (stricter compliance gate, cost policy, etc.) and fingerprint that instead.
import { createHash } from 'node:crypto';
import type { PromotionEvidence, PromotionDecision, PromotionRule, Score } from './types.js';

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

// The `<=`/`<`/`>` comparisons below are all JS numeric comparisons: they silently return `false` for
// `NaN`, `undefined`, and non-finite values, which makes an unvalidated Score fail OPEN rather than
// closed (e.g. a `NaN` primary never trips `primary_regressed`; a negative `baseline.noopRate` puts
// clause 2 into its at-floor branch, which a negative `candidate.noopRate` then also satisfies). `Score`
// is only a TypeScript interface — nothing upstream guarantees these are real, in-domain numbers at
// runtime (an untrusted replay bundle, a buggy Evaluator). Reject any evidence that isn't finite and
// in-domain before any clause runs, rather than let one bad axis quietly widen what "improved" means.
function isValidScore(s: Score): boolean {
  return (
    isFiniteNumber(s.primary) &&
    isFiniteNumber(s.noopRate) && s.noopRate >= 0 && s.noopRate <= 1 &&
    isFiniteNumber(s.costPerWin) && s.costPerWin >= 0
  );
}

/**
 * The default frozen gate. Conjunctive — a candidate is promoted iff EVERY clause holds:
 *   0. baseline, candidate, and (if supplied) anchor are finite, in-domain evidence — not NaN,
 *      not ±Infinity, not a missing/mistyped field, `noopRate` in [0,1], `costPerWin` ≥ 0 — otherwise
 *      REJECT outright (`invalid_score_evidence`) without evaluating clauses 1-5 on unusable numbers.
 *   1. primary does not regress   (candidate.primary ≥ baseline.primary)
 *   2. no-op rate strictly improves (candidate.noopRate < baseline.noopRate) — the load-bearing signal;
 *      a policy earns a promotion by making the executor COMMIT more, not just score higher.
 *      noopRate is a floor-0 rate: once baseline.noopRate is already at (or below) the floor, "strictly
 *      improves" is unsatisfiable by construction, so a tie AT the floor satisfies this clause instead —
 *      otherwise a policy that reaches 0 no-ops can never be promoted again on any other axis (a
 *      ceiling-lockout that silently blocked real, otherwise-qualifying candidates in
 *      experiments/signal-flywheel's own committed lineage). Clause 0's `noopRate >= 0` means "at floor"
 *      now only ever means EXACTLY 0, not "0 or below" — a negative noopRate is invalid evidence, not a
 *      lower floor.
 *   3. cost/win does not worsen   (candidate.costPerWin ≤ baseline.costPerWin)
 *   4. no hard safety/security regression
 *   5. if an anchor is supplied, it must not regress (candidate ≥ baseline) — the anti-Goodhart guard
 */
export function meetsPromotionRule(e: PromotionEvidence): PromotionDecision {
  if (
    !isValidScore(e.baseline) ||
    !isValidScore(e.candidate) ||
    (e.anchor && (!isFiniteNumber(e.anchor.baseline) || !isFiniteNumber(e.anchor.candidate)))
  ) {
    return { promote: false, reasons: ['invalid_score_evidence'] };
  }
  const reasons: string[] = [];
  if (e.candidate.primary < e.baseline.primary) reasons.push('primary_regressed');
  const baselineAtFloor = e.baseline.noopRate <= 0;
  const noopImproved = baselineAtFloor ? e.candidate.noopRate <= 0 : e.candidate.noopRate < e.baseline.noopRate;
  if (!noopImproved) reasons.push('noop_rate_not_improved');
  if (e.candidate.costPerWin > e.baseline.costPerWin) reasons.push('cost_per_win_worsened');
  if (e.candidate.regressed) reasons.push('safety_regressed');
  if (e.anchor && e.anchor.candidate < e.anchor.baseline) reasons.push('anchor_regressed');
  return { promote: reasons.length === 0, reasons };
}

/**
 * A fingerprint of a promotion rule's source — an external reviewer recomputes this and compares it to a
 * pinned value to prove the gate was UNCHANGED between runs. `Function.prototype.toString` is stable for
 * a given source; for a build-artifact-level guarantee, hash the rule's source file instead and pass it.
 */
export function gateFingerprint(rule: PromotionRule): string {
  return createHash('sha256').update(rule.toString()).digest('hex');
}
