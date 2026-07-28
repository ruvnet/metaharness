// The funnel's FROZEN promotion gate — injected into the flywheel in place of
// the default `meetsPromotionRule` (the flywheel is designed for exactly this).
// Conjunctive: every clause must hold or the candidate is rejected.
//
// The gate never moves during a run; its sha256 fingerprint is pinned in the
// replay bundle so an outside reviewer can prove it was unchanged AND re-run it
// against each promotion's sealed scores.

/** @type {import('@metaharness/flywheel').PromotionRule} */
export function funnelPromotionRule(e) {
  const reasons = [];
  // 1. CVR must improve by ≥2% RELATIVE — beyond simulator noise, no vanity promotions.
  if (!(e.candidate.primary >= e.baseline.primary * 1.02)) reasons.push('cvr_lift_below_2pct');
  // 2. Bounce rate must not meaningfully worsen — no buying conversion with junk landing UX.
  if (e.candidate.noopRate > e.baseline.noopRate + 0.005) reasons.push('bounce_worsened');
  // 3. Cost per acquisition must not worsen — lift that raises CAC is not lift.
  if (e.candidate.costPerWin > e.baseline.costPerWin) reasons.push('cac_worsened');
  // 4. Compliance hard stop — dark patterns and refund spikes block promotion outright.
  if (e.candidate.regressed) reasons.push('compliance_regressed');
  // 5. The frozen mobile-heavy anchor must not regress — the anti-Goodhart guard.
  if (e.anchor && e.anchor.candidate < e.anchor.baseline) reasons.push('anchor_regressed');
  return { promote: reasons.length === 0, reasons };
}
