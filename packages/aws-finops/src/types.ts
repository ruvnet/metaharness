// SPDX-License-Identifier: MIT
//
// Domain contract for the Darwin FinOps harness (ADR-168). These types are the
// substrate-swap of the Darwin Shield (ADR-155/167): the security "Finding" becomes
// a cost "OptimizationProposal", the crash oracle becomes a three-part cost oracle,
// and the residual set of un-fixed vulns becomes the residual modeled bill.
//
// PURE & dependency-free. Nothing here touches a binary, the network, or AWS.

/** A single priced resource as reported by a cost tool (infracost), normalized. */
export interface ResourceCost {
  /** Terraform address, e.g. "aws_instance.web" or "module.db.aws_db_instance.this". */
  address: string;
  /** Resource type, e.g. "aws_instance". */
  resourceType: string;
  /** Modeled monthly cost in USD (0 for free/usage-only resources with no estimate). */
  monthlyUsd: number;
}

/** Normalized cost report for one template — the shape both infracost flows reduce to. */
export interface CostReport {
  /** Total modeled monthly cost in USD across all resources. */
  totalMonthlyUsd: number;
  /** Per-resource breakdown (may be empty if the tool only emitted a total). */
  resources: ResourceCost[];
  /** The currency the figures are in (infracost defaults to USD). */
  currency: string;
}

/** The signed cost change between a baseline template and a patched one. */
export interface CostDelta {
  baselineMonthlyUsd: number;
  patchedMonthlyUsd: number;
  /** patched − baseline. Negative ⇒ the patch reduces the modeled bill. */
  diffMonthlyUsd: number;
}

/** One checkov policy result, normalized. */
export interface PolicyResult {
  /** Check id, e.g. "CKV_AWS_79". */
  id: string;
  /** Terraform resource address the check applies to. */
  resource: string;
  passed: boolean;
}

/** Normalized checkov report for one template. */
export interface PolicyReport {
  passed: number;
  failed: number;
  /** Stable set of failed-check keys ("<id>@<resource>") for non-regression diffing. */
  failedKeys: string[];
}

/** A CloudWatch-derived utilization sample for one resource over a window (read-only evidence). */
export interface UtilizationSample {
  address: string;
  /** Window length in days the percentiles were computed over. */
  windowDays: number;
  /** p95 CPU utilization in percent (0–100), the primary right-sizing gate. */
  cpuP95: number;
  /** Optional p95 memory utilization in percent, when the CW agent reports it. */
  memP95?: number;
}

/** A concrete optimization the harness proposes for a single resource (a Terraform patch). */
export interface OptimizationProposal {
  /** Resource address the patch targets. */
  address: string;
  /** Short machine tag for the optimization class, e.g. "gp2-to-gp3", "rightsize". */
  kind: string;
  /** The patched Terraform source (full template after applying the change). */
  patchedTemplate: string;
  /** Whether this proposal changes capacity/size (⇒ requires utilization evidence). */
  requiresUtilizationEvidence: boolean;
  /** Human-readable one-line rationale (no secrets, no credentials). */
  rationale: string;
}

/** Inputs the deterministic oracle needs to rule on a proposal. */
export interface OracleInput {
  /** Did `terraform validate`/`plan` succeed on the patched template? */
  buildOk: boolean;
  /** Cost of baseline vs patched (from infracost). */
  delta: CostDelta;
  /** Compliance on the baseline and patched templates (from checkov). */
  policyBefore: PolicyReport;
  policyAfter: PolicyReport;
  /** The proposal under test (for the utilization-evidence gate). */
  proposal: OptimizationProposal;
  /** Utilization evidence keyed by address, when available (read-only CloudWatch). */
  utilization?: Record<string, UtilizationSample>;
}

/** The oracle's verdict: accept iff build-safe AND compliance-safe AND provably cheaper. */
export interface OracleVerdict {
  accepted: boolean;
  /** Ordered, human-readable reasons (each gate that passed or the first that failed). */
  reasons: string[];
}

/** An optimization the oracle accepted — the FinOps analogue of a VerifiedFinding. */
export interface VerifiedSaving {
  address: string;
  kind: string;
  /** Modeled monthly savings in USD (positive number = dollars off the bill). */
  monthlySavingsUsd: number;
  rationale: string;
  /** True if the saving is backed by CloudWatch utilization evidence. */
  utilizationBacked: boolean;
}

/** The shrinking residual: what is left to optimize after landing verified savings. */
export interface FinOpsResidual {
  /** The template's modeled monthly bill before any optimization. */
  baselineMonthlyUsd: number;
  /** baseline − Σ verified savings (the bill that remains, modeled). */
  residualMonthlyUsd: number;
  /** Σ verified savings in USD/month. */
  realizedSavingsUsd: number;
  /** Fraction of the baseline bill removed (0–1). */
  savingsRatio: number;
  /** Resource addresses with no accepted optimization yet (the work that remains). */
  unoptimizedAddresses: string[];
}
