// SPDX-License-Identifier: MIT
//
// @metaharness/projects — review-gates.ts (ADR-166 Human Review Gates).
//
// Borrows the "human-gated deterministic verification" pattern: keep verification
// deterministic and automatic for the bulk of the stream, and spend scarce human
// attention ONLY on the uncertain edge — the changes that touch risk, can't be
// cheaply afforded, or whose benchmark verdict straddles zero (statistically
// ambiguous). The goal is to cut human review rate ~50% WITHOUT raising escaped
// defects, by routing humans to exactly the cases where automation is least sure.
//
// Crucially distinct from immutable safety rails: a safety rail REJECTS without a
// human (fail-closed). A review gate ASKS a human (route='human') — the change is
// not blocked, it is escalated for judgment. This module only routes; it never
// rejects.
//
// The optimization (measured in bench/review-gates.bench.mjs): a "review everything"
// baseline asks a human on 100% of changes. The gate asks on the uncertain subset.
// On a stream where defects concentrate on that edge, the gate catches the same
// defects (escapedDefects ≈ 0) while reviewing far fewer items — the reduction.
//
// Determinism note: routing reads ONLY observable signals. ground-truth
// `actuallyDefective` is used solely by the simulation/metrics, never by routeReview.

import type { BootstrapResult } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Context, policy, and decision shapes.
// ─────────────────────────────────────────────────────────────────────────────

/** One change presented to the review gate. */
export interface ReviewContext {
  id: string;
  /** A file flagged high-risk (auth, migrations, infra) was modified. */
  highRiskFileTouched: boolean;
  /** The change touches security-sensitive code paths. */
  securitySensitiveChange: boolean;
  /** Cost-units already spent producing/verifying this change. */
  costUnits: number;
  /** 0..1 — the harness's own confidence the change is correct. */
  confidence: number;
  /** The promotion bootstrap for this change's benchmark delta. */
  bootstrap: BootstrapResult;
  /**
   * Ground truth: whether the change is REALLY defective. Used only by the
   * simulation/metrics to count escaped defects — NEVER read by routing.
   */
  actuallyDefective: boolean;
}

/** Thresholds that define the "uncertain edge". */
export interface ReviewGatePolicy {
  /** Route to human when confidence is strictly below this. */
  confidenceThreshold: number;
  /** Route to human when costUnits strictly exceed this. */
  costBudget: number;
}

/** Conservative defaults: trust >=0.7 confidence, escalate spend over 20 units. */
export function defaultReviewPolicy(): ReviewGatePolicy {
  return { confidenceThreshold: 0.7, costBudget: 20 };
}

/** Where a change is routed. */
export type Route = 'auto' | 'human';

/** A routing decision plus the human-readable triggers that fired. */
export interface ReviewDecision {
  route: Route;
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing (deterministic; ignores ground truth).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route a change to 'human' iff ANY trigger fires:
 *   - highRiskFileTouched
 *   - securitySensitiveChange
 *   - costUnits > policy.costBudget          (expensive enough to warrant a look)
 *   - confidence < policy.confidenceThreshold (the harness isn't sure)
 *   - ambiguous benchmark: the bootstrap CI straddles zero (lower95 <= 0 <= upper95)
 *     → the candidate is not statistically distinguishable from the incumbent.
 * Otherwise 'auto'. `reasons` lists exactly which triggers fired, in a fixed order.
 *
 * Routing reads ONLY observable signals — never ctx.actuallyDefective — so flipping
 * the ground-truth label cannot change the route.
 */
export function routeReview(ctx: ReviewContext, policy: ReviewGatePolicy = defaultReviewPolicy()): ReviewDecision {
  const reasons: string[] = [];

  if (ctx.highRiskFileTouched) reasons.push('high-risk-file');
  if (ctx.securitySensitiveChange) reasons.push('security-sensitive');
  if (ctx.costUnits > policy.costBudget) reasons.push('over-budget');
  if (ctx.confidence < policy.confidenceThreshold) reasons.push('low-confidence');
  // Ambiguous benchmark: the 95% CI includes zero → verdict is inconclusive.
  if (ctx.bootstrap.lower95 <= 0 && ctx.bootstrap.upper95 >= 0) reasons.push('ambiguous-benchmark');

  return { route: reasons.length > 0 ? 'human' : 'auto', reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream simulation + metrics (the only consumer of ground truth).
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome of routing a whole stream, gated vs. a review-everything baseline. */
export interface ReviewStreamResult {
  /** Fraction of the stream routed to a human (0..1). */
  humanRate: number;
  /** Real defects that the gate routed to 'auto' (missed). */
  escapedDefects: number;
  /** Real defects escaped by the review-EVERYTHING baseline (always 0). */
  reviewAllEscaped: number;
  /** Reduction in human reviews vs reviewing 100% of the stream (= 1 − humanRate). */
  reductionPct: number;
}

/**
 * Simulate routing a stream and measure the gate against a baseline that sends
 * every change to a human.
 *
 *   humanRate       = (# routed 'human') / stream.length
 *   escapedDefects  = # of actuallyDefective changes the gate routed 'auto'
 *   reviewAllEscaped= 0 (the baseline reviews everything, so it catches all defects)
 *   reductionPct    = 1 − humanRate (human effort saved vs the baseline)
 *
 * A well-correlated stream (defects concentrate on the uncertain edge) yields a low
 * humanRate AND escapedDefects ≈ 0 — half the reviews, none of the misses.
 */
export function simulateReviewStream(
  stream: ReviewContext[],
  policy: ReviewGatePolicy = defaultReviewPolicy(),
): ReviewStreamResult {
  const n = stream.length;
  if (n === 0) return { humanRate: 0, escapedDefects: 0, reviewAllEscaped: 0, reductionPct: 1 };

  let humanCount = 0;
  let escapedDefects = 0;

  for (const ctx of stream) {
    const decision = routeReview(ctx, policy); // routing never reads actuallyDefective
    if (decision.route === 'human') {
      humanCount += 1;
    } else if (ctx.actuallyDefective) {
      // Routed auto but really defective → it escaped the gate (metrics-only).
      escapedDefects += 1;
    }
  }

  const humanRate = +(humanCount / n).toFixed(6);
  return {
    humanRate,
    escapedDefects,
    reviewAllEscaped: 0,
    reductionPct: +(1 - humanRate).toFixed(6),
  };
}
