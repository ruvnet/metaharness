// SPDX-License-Identifier: MIT
//
// @metaharness/projects — scheduler.ts (ADR-160 Escalation Scheduler).
//
// A bounded executor for the harness graph, borrowed from structured-graph
// scheduling research: every run terminates, every termination is TYPED, and the
// scheduler fails CLOSED on security uncertainty. The four ways an agent run
// silently burns money — infinite retry loops, runaway frontier escalation,
// context blow-up, and budget overrun — are each capped by an explicit policy
// bound, and the FIRST bound hit produces a typed TerminationReason.
//
// The optimization (measured in bench/scheduler.bench.mjs): on FAILING tasks a
// naive "retry until success" loop pays unbounded cost-units, while the bounded
// scheduler stops at the first cap. The bench reports the cost-unit reduction.

import { round6 } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Typed termination + policy.
// ─────────────────────────────────────────────────────────────────────────────

/** The exhaustive set of reasons a scheduled run can stop. */
export type TerminationReason =
  | 'success'
  | 'budget_exhausted'
  | 'max_retries'
  | 'max_escalations'
  | 'max_reviewer_passes'
  | 'context_overflow'
  | 'security_uncertain';

/** The bounds that guarantee termination and fail-closed behavior. */
export interface SchedulerPolicy {
  maxRetriesPerNode: number;
  maxFrontierEscalations: number;
  maxContextGrowthRatio: number;
  maxReviewerPasses: number;
  costBudget: number;
  timeBudget: number;
  failClosedOnSecurityUncertainty: boolean;
}

/** Conservative, safety-first defaults. */
export function defaultSchedulerPolicy(): SchedulerPolicy {
  return {
    maxRetriesPerNode: 3,
    maxFrontierEscalations: 2,
    maxContextGrowthRatio: 4,
    maxReviewerPasses: 3,
    costBudget: 20,
    timeBudget: 5,
    failClosedOnSecurityUncertainty: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node contract.
// ─────────────────────────────────────────────────────────────────────────────

/** The result of running one node attempt. */
export interface NodeResult {
  ok: boolean;
  costUnits: number;
  timeUnits: number;
  /** When true (and policy fails closed), the run terminates immediately. */
  securityUncertain?: boolean;
  /** When true, this attempt consumed a frontier escalation. */
  escalate?: boolean;
  /** Cumulative context-growth ratio reported by the node (1 = no growth). */
  contextGrowth?: number;
}

/** A schedulable node. `run(attempt)` is invoked with 1-based attempt counts. */
export interface SchedNode {
  id: string;
  run(attempt: number): NodeResult;
}

/** The summary returned by EscalationScheduler.run. */
export interface SchedulerOutcome {
  reason: TerminationReason;
  steps: number;
  costUnits: number;
  timeUnits: number;
  escalations: number;
  perNode: { id: string; attempts: number; ok: boolean }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The bounded scheduler.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes nodes in order. Each node is attempted up to maxRetriesPerNode times;
 * cumulative cost/time are checked against budgets; frontier escalations and
 * reviewer passes are counted against their caps; the largest reported context
 * growth ratio is checked against maxContextGrowthRatio. The FIRST terminal
 * condition encountered wins. The loop is provably finite: nodes are finite and
 * each node's attempts are capped, so the worst case is nodes × maxRetriesPerNode
 * attempts before forced termination.
 */
export class EscalationScheduler {
  constructor(private readonly policy: SchedulerPolicy) {}

  run(nodes: SchedNode[]): SchedulerOutcome {
    const p = this.policy;
    // Every node gets at least one attempt — a 0 budget must not report
    // 'max_retries' for a node that was never even invoked.
    const maxAttempts = Math.max(1, p.maxRetriesPerNode);
    let steps = 0;
    let costUnits = 0;
    let timeUnits = 0;
    let escalations = 0;
    let reviewerPasses = 0;
    let maxGrowth = 1;
    const perNode: { id: string; attempts: number; ok: boolean }[] = [];

    // Helper: finalize and return a typed outcome.
    const done = (reason: TerminationReason): SchedulerOutcome => ({
      reason,
      steps,
      costUnits: round6(costUnits),
      timeUnits: round6(timeUnits),
      escalations,
      perNode,
    });

    for (const node of nodes) {
      let attempts = 0;
      let ok = false;

      // Bounded retry loop for this node (<= maxAttempts, always >= 1).
      while (attempts < maxAttempts) {
        attempts += 1;
        steps += 1;
        const r = node.run(attempts);

        // Account first so budgets reflect the work that was actually performed.
        costUnits += r.costUnits;
        timeUnits += r.timeUnits;
        if (r.escalate) escalations += 1;
        if (r.contextGrowth !== undefined && r.contextGrowth > maxGrowth) maxGrowth = r.contextGrowth;

        // Fail closed on security uncertainty — highest-priority terminal check.
        if (r.securityUncertain && p.failClosedOnSecurityUncertainty) {
          perNode.push({ id: node.id, attempts, ok: false });
          return done('security_uncertain');
        }

        // Bound checks (any breach is terminal; report the most cost-relevant one).
        if (costUnits > p.costBudget) {
          perNode.push({ id: node.id, attempts, ok: r.ok });
          return done('budget_exhausted');
        }
        if (timeUnits > p.timeBudget) {
          perNode.push({ id: node.id, attempts, ok: r.ok });
          return done('budget_exhausted');
        }
        if (maxGrowth > p.maxContextGrowthRatio) {
          perNode.push({ id: node.id, attempts, ok: r.ok });
          return done('context_overflow');
        }
        if (escalations > p.maxFrontierEscalations) {
          perNode.push({ id: node.id, attempts, ok: r.ok });
          return done('max_escalations');
        }

        if (r.ok) {
          ok = true;
          break;
        }
        // Not ok and not terminal → retry (loop guard enforces the cap).
      }

      perNode.push({ id: node.id, attempts, ok });

      // Reviewer-pass cap: every successful reviewer node consumes a pass.
      if (ok && node.id.startsWith('review')) {
        reviewerPasses += 1;
        if (reviewerPasses > p.maxReviewerPasses) return done('max_reviewer_passes');
      }

      // Exhausted the retry budget without success → typed max_retries.
      if (!ok) return done('max_retries');
    }

    // All nodes succeeded within every bound.
    return done('success');
  }
}
