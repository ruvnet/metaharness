// SPDX-License-Identifier: MIT
//
// infracost JSON → normalized CostReport / CostDelta. PURE: parses an already-
// captured JSON object (the bench shells out to the binary; the parser never does).
//
// Tolerant across infracost shapes we've seen in the wild:
//   - classic `breakdown`/`diff`: top-level `totalMonthlyCost` (string USD),
//     `projects[].breakdown.resources[]` with `monthlyCost` + `name`/`resourceType`,
//     and on a diff `pastTotalMonthlyCost` / `diffTotalMonthlyCost`.
//   - modern `scan --json`: `monthly_cost`, `monthly_savings`, `failing_policies`.
// Unknown/missing fields degrade gracefully to 0 rather than throwing.

import type { CostReport, CostDelta, ResourceCost } from './types.js';

const num = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

/** Extract per-resource costs from a classic infracost `projects[].breakdown.resources[]`. */
function resourcesOf(obj: Record<string, unknown>): ResourceCost[] {
  const out: ResourceCost[] = [];
  const projects = Array.isArray(obj.projects) ? obj.projects : [];
  for (const p of projects as Array<Record<string, unknown>>) {
    const breakdown = (p.breakdown ?? p) as Record<string, unknown>;
    const resources = Array.isArray(breakdown.resources) ? breakdown.resources : [];
    for (const r of resources as Array<Record<string, unknown>>) {
      const address = String(r.name ?? r.address ?? '');
      if (!address) continue;
      out.push({
        address,
        resourceType: String(r.resourceType ?? r.resource_type ?? address.split('.')[0] ?? ''),
        monthlyUsd: num(r.monthlyCost ?? r.monthly_cost),
      });
    }
  }
  return out;
}

/**
 * Parse an infracost JSON object into a normalized CostReport. Accepts both the
 * classic breakdown shape and the modern `scan --json` shape.
 */
export function parseCostReport(json: unknown): CostReport {
  const obj = (json ?? {}) as Record<string, unknown>;
  const resources = resourcesOf(obj);
  // Prefer an explicit total; otherwise sum the resources we found.
  const explicitTotal =
    obj.totalMonthlyCost !== undefined
      ? num(obj.totalMonthlyCost)
      : obj.monthly_cost !== undefined
        ? num(obj.monthly_cost)
        : undefined;
  const totalMonthlyUsd =
    explicitTotal ?? resources.reduce((a, r) => a + r.monthlyUsd, 0);
  return {
    totalMonthlyUsd,
    resources,
    currency: String(obj.currency ?? 'USD'),
  };
}

/**
 * Compute the signed cost delta between a baseline and a patched report.
 * Negative `diffMonthlyUsd` ⇒ the patch reduces the modeled bill.
 *
 * If the patched JSON is a native infracost *diff* (has `diffTotalMonthlyCost`),
 * that signed field is used directly; otherwise the two totals are subtracted.
 */
export function costDelta(baseline: CostReport, patched: CostReport, nativeDiff?: unknown): CostDelta {
  let diff = patched.totalMonthlyUsd - baseline.totalMonthlyUsd;
  if (nativeDiff && typeof nativeDiff === 'object') {
    const d = (nativeDiff as Record<string, unknown>).diffTotalMonthlyCost;
    if (d !== undefined) diff = num(d);
  }
  return {
    baselineMonthlyUsd: baseline.totalMonthlyUsd,
    patchedMonthlyUsd: patched.totalMonthlyUsd,
    diffMonthlyUsd: diff,
  };
}
