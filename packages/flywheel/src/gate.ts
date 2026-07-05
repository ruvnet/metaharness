// @metaharness/flywheel — the DEFAULT promotion gate + its fingerprint.
//
// "The gate is the product." A promotion is only as trustworthy as the rule that admitted it, and that
// rule must be FROZEN for a deployment and VERIFIABLY unchanged. This is the default conjunctive rule
// (every clause load-bearing; ALL must hold) — but it is just a `PromotionRule`, so a caller may inject
// its own (stricter compliance gate, cost policy, etc.) and fingerprint that instead.
import { createHash } from 'node:crypto';
import type { PromotionEvidence, PromotionDecision, PromotionRule } from './types.js';

/**
 * The default frozen gate. Conjunctive — a candidate is promoted iff EVERY clause holds:
 *   1. primary does not regress   (candidate.primary ≥ baseline.primary)
 *   2. no-op rate strictly improves (candidate.noopRate < baseline.noopRate) — the load-bearing signal;
 *      a policy earns a promotion by making the executor COMMIT more, not just score higher
 *   3. cost/win does not worsen   (candidate.costPerWin ≤ baseline.costPerWin)
 *   4. no hard safety/security regression
 *   5. if an anchor is supplied, it must not regress (candidate ≥ baseline) — the anti-Goodhart guard
 */
export function meetsPromotionRule(e: PromotionEvidence): PromotionDecision {
  const reasons: string[] = [];
  if (e.candidate.primary < e.baseline.primary) reasons.push('primary_regressed');
  if (!(e.candidate.noopRate < e.baseline.noopRate)) reasons.push('noop_rate_not_improved');
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
