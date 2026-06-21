// SPDX-License-Identifier: MIT
//
// SHRINKING RESIDUAL (ADR-168) — ported from the Darwin Shield's "set of un-fixed
// vulnerabilities shrinks each generation". Here the residual is the modeled
// monthly bill that REMAINS after landing verified savings, plus the set of
// resources with no accepted optimization yet. Each verified saving monotonically
// shrinks the residual; the loop terminates when no remaining hotspot yields an
// oracle-passing patch. PURE & deterministic.

import type { CostReport, VerifiedSaving, FinOpsResidual } from './types.js';
import { round2, round6 } from './core.js';

/**
 * Compute the residual from a baseline cost report and the savings verified so far.
 * `realizedSavings` is clamped to the baseline (you cannot save more than the bill).
 */
export function computeResidual(baseline: CostReport, verified: VerifiedSaving[]): FinOpsResidual {
  const baselineMonthlyUsd = round2(baseline.totalMonthlyUsd);
  const rawSavings = verified.reduce((a, v) => a + v.monthlySavingsUsd, 0);
  const realizedSavingsUsd = round2(Math.min(rawSavings, baselineMonthlyUsd));
  const residualMonthlyUsd = round2(Math.max(0, baselineMonthlyUsd - realizedSavingsUsd));

  const optimized = new Set(verified.map((v) => v.address));
  const unoptimizedAddresses = baseline.resources
    .map((r) => r.address)
    .filter((a) => !optimized.has(a))
    .sort();

  const savingsRatio = baselineMonthlyUsd > 0 ? round6(realizedSavingsUsd / baselineMonthlyUsd) : 0;

  return {
    baselineMonthlyUsd,
    residualMonthlyUsd,
    realizedSavingsUsd,
    savingsRatio,
    unoptimizedAddresses,
  };
}

/**
 * The terminal condition for the Darwin loop: true when the residual can no longer
 * shrink — either everything is optimized, or the last generation produced no new
 * verified saving. `prev`/`next` are successive residual snapshots.
 */
export function residualConverged(prev: FinOpsResidual | null, next: FinOpsResidual): boolean {
  if (next.unoptimizedAddresses.length === 0) return true;
  if (prev === null) return false;
  return next.realizedSavingsUsd <= prev.realizedSavingsUsd; // no progress this generation
}
