// SPDX-License-Identifier: MIT
//
// The DETERMINISTIC COST ORACLE (ADR-168) — the anti-hallucination spine, ported
// from the Darwin Shield. A frontier model's $0.04 Terraform patch is accepted iff
// THREE off-the-shelf tools agree:
//
//   1. build      — terraform validate/plan exit 0 on the patched template;
//   2. compliance — checkov reports NO NEW failed policies vs the baseline;
//   3. savings    — infracost's modeled monthly bill strictly DROPS (beyond epsilon);
//   4. (gate)     — capacity-changing patches require CloudWatch under-utilization
//                   evidence; without it the proposal is rejected (we never guess).
//
// The model is never trusted; only the tools. PURE & deterministic: same inputs ⇒
// same verdict, no binaries or network here (the bench captures tool output upstream).

import type { OracleInput, OracleVerdict, VerifiedSaving } from './types.js';
import { newFailures } from './checkov-adapter.js';
import { round2 } from './core.js';

export interface OracleOptions {
  /** Minimum modeled monthly savings (USD) to count as a win. Default 0.01 (1¢). */
  minSavingsUsd?: number;
  /** Right-sizing is allowed only if p95 CPU is below this percent. Default 40. */
  maxCpuP95ForRightsize?: number;
}

/**
 * Rule on a single optimization proposal. Returns accept/reject + ordered reasons.
 * Gates are checked in a fixed order; the first failure short-circuits the reasons
 * with a clear cause, so a rejected proposal always says *why*.
 */
export function verifyProposal(input: OracleInput, opts: OracleOptions = {}): OracleVerdict {
  const minSavings = opts.minSavingsUsd ?? 0.01;
  const maxCpu = opts.maxCpuP95ForRightsize ?? 40;
  const reasons: string[] = [];

  // Gate 1: build must succeed.
  if (!input.buildOk) {
    return { accepted: false, reasons: ['REJECT build: terraform validate/plan failed on patched template'] };
  }
  reasons.push('PASS build: terraform validate/plan ok');

  // Gate 2: compliance non-regression (no NEW failed checks).
  const broke = newFailures(input.policyBefore, input.policyAfter);
  if (broke.length > 0) {
    return {
      accepted: false,
      reasons: [...reasons, `REJECT compliance: patch introduces ${broke.length} new checkov failure(s): ${broke.slice(0, 5).join(', ')}`],
    };
  }
  reasons.push('PASS compliance: no new checkov failures');

  // Gate 3: capacity-changing patches need utilization evidence.
  if (input.proposal.requiresUtilizationEvidence) {
    const sample = input.utilization?.[input.proposal.address];
    if (!sample) {
      return {
        accepted: false,
        reasons: [...reasons, 'REJECT evidence: rightsizing requires CloudWatch utilization data (none available)'],
      };
    }
    if (sample.cpuP95 >= maxCpu) {
      return {
        accepted: false,
        reasons: [...reasons, `REJECT evidence: p95 CPU ${sample.cpuP95}% ≥ ${maxCpu}% — not safe to downsize`],
      };
    }
    reasons.push(`PASS evidence: p95 CPU ${sample.cpuP95}% < ${maxCpu}% over ${sample.windowDays}d`);
  }

  // Gate 4: the modeled bill must strictly drop beyond epsilon.
  const savings = -input.delta.diffMonthlyUsd; // positive = dollars off the bill
  if (savings < minSavings) {
    return {
      accepted: false,
      reasons: [...reasons, `REJECT savings: modeled monthly delta ${round2(input.delta.diffMonthlyUsd)} USD is not a reduction ≥ ${minSavings}`],
    };
  }
  reasons.push(`PASS savings: modeled bill drops ${round2(savings)} USD/month`);

  return { accepted: true, reasons };
}

/** Build the VerifiedSaving record for an accepted proposal (assumes verifyProposal accepted). */
export function toVerifiedSaving(input: OracleInput): VerifiedSaving {
  return {
    address: input.proposal.address,
    kind: input.proposal.kind,
    monthlySavingsUsd: round2(-input.delta.diffMonthlyUsd),
    rationale: input.proposal.rationale,
    utilizationBacked: Boolean(input.utilization?.[input.proposal.address]),
  };
}
