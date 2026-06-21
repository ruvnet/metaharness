// SPDX-License-Identifier: MIT
//
// checkov JSON → normalized PolicyReport. PURE: parses an already-captured JSON
// object. Tolerant of checkov's two top-level shapes: a single `{results:{...}}`
// object, or an array of such objects (one per check type) when multiple
// frameworks run. Missing fields degrade to empty rather than throwing.

import type { PolicyReport, PolicyResult } from './types.js';

/** Stable key for a failed check so two reports can be diffed for NEW failures. */
export function failKey(r: PolicyResult): string {
  return `${r.id}@${r.resource}`;
}

function collect(node: unknown, out: PolicyResult[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const results = (obj.results ?? {}) as Record<string, unknown>;
  const passed = Array.isArray(results.passed_checks) ? results.passed_checks : [];
  const failed = Array.isArray(results.failed_checks) ? results.failed_checks : [];
  for (const c of passed as Array<Record<string, unknown>>) {
    out.push({ id: String(c.check_id ?? ''), resource: String(c.resource ?? ''), passed: true });
  }
  for (const c of failed as Array<Record<string, unknown>>) {
    out.push({ id: String(c.check_id ?? ''), resource: String(c.resource ?? ''), passed: false });
  }
}

/** Parse a checkov JSON object (object or array form) into a normalized PolicyReport. */
export function parsePolicyReport(json: unknown): PolicyReport {
  const results: PolicyResult[] = [];
  collect(json, results);
  const failed = results.filter((r) => !r.passed);
  const passed = results.filter((r) => r.passed);
  // Dedup failed keys (the same check can appear across frameworks).
  const failedKeys = Array.from(new Set(failed.map(failKey))).sort();
  return { passed: passed.length, failed: failed.length, failedKeys };
}

/**
 * Compliance non-regression: returns the failed-check keys present in `after`
 * but NOT in `before` (i.e. policies the patch newly broke). Empty ⇒ safe.
 */
export function newFailures(before: PolicyReport, after: PolicyReport): string[] {
  const had = new Set(before.failedKeys);
  return after.failedKeys.filter((k) => !had.has(k));
}
