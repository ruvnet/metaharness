// SPDX-License-Identifier: MIT
//
// The accept/reject decision rule — "correctness first, cost second, receipts always":
//   accepted = taskResolved && workspaceDrift < threshold && noCriticalSafetyFlags && receiptCoverage===1
// Returns the reasons so a rejection is auditable (which clause failed), not a bare boolean.

import type { DecisionInput, DecisionResult } from './types.js';
import { hasCriticalTrigger } from './safety.js';

export function decide(input: DecisionInput): DecisionResult {
  const reasons: string[] = [];
  if (!input.taskResolved) reasons.push('task not resolved');
  if (!(input.workspaceDrift < input.driftThreshold)) {
    reasons.push(`workspace drift ${input.workspaceDrift.toFixed(4)} >= threshold ${input.driftThreshold}`);
  }
  if (hasCriticalTrigger(input.triggers)) {
    const crit = input.triggers.filter((t) => t.critical).map((t) => t.concept);
    reasons.push(`critical safety trigger(s): ${[...new Set(crit)].join(', ')}`);
  }
  if (input.receiptCoverage !== 1) {
    reasons.push(`receipt coverage ${input.receiptCoverage} != 1 (not every decision was witnessed)`);
  }
  return { accepted: reasons.length === 0, reasons };
}
