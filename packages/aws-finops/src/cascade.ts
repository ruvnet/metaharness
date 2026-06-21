// SPDX-License-Identifier: MIT
//
// MULTI-TIER CASCADE (ADR-168) — the same shape as the Darwin Shield discovery
// cascade (ADR-167 src/discovery.ts), re-pointed at cost:
//
//   hotspot scan (checkov/infracost) → cheap-LLM triage (is this a genuine, low-risk
//   optimization?) → frontier-LLM proposes a Terraform patch → DETERMINISTIC ORACLE
//   verifies (build + compliance + savings + evidence) → escalate cheap→frontier only
//   on oracle-fail → only verified savings reported → residual shrinks.
//
// Lanes are INJECTED (triage / propose / verify), so the cascade is unit-tested
// deterministically with no real LLM and no binaries. The product metric is
// cost-per-verified-dollar-saved. PURE orchestration over injected effects.

import type {
  CostReport,
  OptimizationProposal,
  OracleVerdict,
  VerifiedSaving,
  FinOpsResidual,
} from './types.js';
import { computeResidual } from './residual.js';
import { round6 } from './core.js';

/** A candidate hotspot surfaced by the cheap static scan (checkov/infracost). */
export interface Hotspot {
  address: string;
  /** Optimization class tag, e.g. "gp2-to-gp3". */
  kind: string;
  /** Modeled monthly cost of this resource (drives ranking). */
  monthlyUsd: number;
}

/** Cheap triage: keep only hotspots worth a frontier proposal. Returns kept + cost. */
export type TriageLane = (h: Hotspot) => Promise<{ keep: boolean; costUsd: number }>;

/** Frontier proposer: turn a kept hotspot into a concrete patch, or null. Returns proposal + cost. */
export type ProposeLane = (
  h: Hotspot,
  tier: 'cheap' | 'frontier',
) => Promise<{ proposal: OptimizationProposal | null; costUsd: number }>;

/** Oracle lane: run build/checkov/infracost on a proposal and rule on it. */
export type VerifyLane = (p: OptimizationProposal) => Promise<{ verdict: OracleVerdict; saving: VerifiedSaving | null }>;

export interface CascadeLanes {
  triage: TriageLane;
  propose: ProposeLane;
  verify: VerifyLane;
}

export interface CascadeOptions {
  /** Escalate to the frontier proposer when the cheap proposer's patch fails the oracle. Default true. */
  escalateOnFail?: boolean;
}

export interface CascadeResult {
  verified: VerifiedSaving[];
  residual: FinOpsResidual;
  /** Total LLM spend across triage + propose lanes (USD). */
  llmCostUsd: number;
  /** llmCostUsd / Σ verified monthly savings — the headline FinOps metric (0 if no savings). */
  costPerVerifiedDollar: number;
  /** Per-hotspot trace for replay/audit. */
  trace: Array<{
    address: string;
    kept: boolean;
    escalated: boolean;
    accepted: boolean;
    reasons: string[];
  }>;
}

/**
 * Run the cascade over the hotspots of a baseline cost report. Deterministic given
 * deterministic lanes. Hotspots are processed highest-cost-first (most bill to win).
 */
export async function runCascade(
  baseline: CostReport,
  hotspots: Hotspot[],
  lanes: CascadeLanes,
  opts: CascadeOptions = {},
): Promise<CascadeResult> {
  const escalateOnFail = opts.escalateOnFail ?? true;
  const ranked = [...hotspots].sort((a, b) => b.monthlyUsd - a.monthlyUsd);

  const verified: VerifiedSaving[] = [];
  const trace: CascadeResult['trace'] = [];
  let llmCostUsd = 0;

  for (const h of ranked) {
    const t = await lanes.triage(h);
    llmCostUsd += t.costUsd;
    if (!t.keep) {
      trace.push({ address: h.address, kept: false, escalated: false, accepted: false, reasons: ['triage: skipped'] });
      continue;
    }

    // Cheap proposal first.
    let escalated = false;
    let accepted = false;
    let reasons: string[] = ['triage: kept'];

    const cheap = await lanes.propose(h, 'cheap');
    llmCostUsd += cheap.costUsd;
    if (cheap.proposal) {
      const v = await lanes.verify(cheap.proposal);
      reasons = reasons.concat(v.verdict.reasons);
      if (v.verdict.accepted && v.saving) {
        verified.push(v.saving);
        accepted = true;
      }
    } else {
      reasons.push('cheap propose: no patch');
    }

    // Escalate to the frontier proposer only if the cheap attempt didn't land.
    if (!accepted && escalateOnFail) {
      escalated = true;
      const front = await lanes.propose(h, 'frontier');
      llmCostUsd += front.costUsd;
      if (front.proposal) {
        const v = await lanes.verify(front.proposal);
        reasons = reasons.concat(v.verdict.reasons.map((r) => `frontier: ${r}`));
        if (v.verdict.accepted && v.saving) {
          verified.push(v.saving);
          accepted = true;
        }
      } else {
        reasons.push('frontier propose: no patch');
      }
    }

    trace.push({ address: h.address, kept: true, escalated, accepted, reasons });
  }

  const residual = computeResidual(baseline, verified);
  const totalSavings = verified.reduce((a, v) => a + v.monthlySavingsUsd, 0);
  const costPerVerifiedDollar = totalSavings > 0 ? round6(llmCostUsd / totalSavings) : 0;

  return { verified, residual, llmCostUsd: round6(llmCostUsd), costPerVerifiedDollar, trace };
}
