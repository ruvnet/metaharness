// SPDX-License-Identifier: MIT
//
// @metaharness/projects — router.ts (escalation ROUTER policy).
//
// This module encodes the cheap→verify→frontier escalation policy that the whole
// program benchmarks: cheap models handle the bulk of work, a deterministic
// verifier gates their output, and only verify failures (or up-front high-stakes
// signals) escalate to a frontier model. The thesis it serves is cost: a cheap
// lane that passes verification never pays for the frontier, so cost-per-pass
// drops without sacrificing the hard cases.
//
// NO real LLM calls live here. The two lanes and the verifier are INJECTED as
// plain functions, so routing and escalation are pure, deterministic, and fully
// unit-testable — same task + same lane fns → same outcome, every time.

import { round6 } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Routing signals + policy.
// ─────────────────────────────────────────────────────────────────────────────

/** Which model tier a task is dispatched to. */
export type Lane = 'cheap' | 'frontier';

/** The signals the router classifies on. `risk`/`value` are normalized 0..1. */
export interface TaskSignal {
  id: string;
  sizeTokens: number;
  risk: number; // 0..1 — chance/impact of a wrong answer
  value: number; // 0..1 — business value of getting it right
  longHorizon: boolean; // multi-step / planning-heavy work
}

/** Thresholds that decide when a task is routed straight to the frontier. */
export interface RouterPolicy {
  cheapMaxTokens: number;
  frontierValueThreshold: number;
  frontierRiskThreshold: number;
}

/** The default router policy — a cheap-first, escalate-on-stakes baseline. */
export function defaultRouterPolicy(): RouterPolicy {
  return {
    cheapMaxTokens: 8000,
    frontierValueThreshold: 0.8,
    frontierRiskThreshold: 0.7,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification. Deterministic: a task goes straight to 'frontier' when ANY
// high-stakes signal fires (long-horizon, high value, high risk, or too large
// for the cheap lane); otherwise it starts 'cheap'. `reasons` lists exactly the
// signals that fired, in a stable order.
// ─────────────────────────────────────────────────────────────────────────────

/** Classify a task into a starting lane plus the reasons that decided it. */
export function classify(
  task: TaskSignal,
  policy: RouterPolicy = defaultRouterPolicy(),
): { lane: Lane; reasons: string[] } {
  const reasons: string[] = [];
  if (task.longHorizon) reasons.push('longHorizon');
  if (task.value >= policy.frontierValueThreshold) reasons.push('value');
  if (task.risk >= policy.frontierRiskThreshold) reasons.push('risk');
  if (task.sizeTokens > policy.cheapMaxTokens) reasons.push('sizeTokens');
  return { lane: reasons.length > 0 ? 'frontier' : 'cheap', reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Escalation execution. Lanes + verifier are injected. The verifier is a pure
// predicate over a LaneResult: passing means the answer is accepted; failing a
// cheap result triggers a single escalation to the frontier.
// ─────────────────────────────────────────────────────────────────────────────

/** What an injected lane function returns: whether it passed and what it cost. */
export interface LaneResult {
  passed: boolean;
  costUnits: number;
}

/** The outcome of running a task through the escalation policy. */
export interface EscalationOutcome {
  passed: boolean;
  /** The lane that produced the passing result, or the last lane tried. */
  finalLane: Lane | 'none';
  /** True only when the frontier ran AFTER a cheap attempt (a real escalation). */
  escalated: boolean;
  /** Number of lane invocations (1 = single lane, 2 = cheap then frontier). */
  attempts: number;
  costUnits: number;
}

/**
 * Run a task through the cheap→verify→frontier policy.
 *
 * - If `classify` routes the task to 'frontier', the cheap lane is SKIPPED
 *   entirely: the frontier runs and is verified (one attempt, escalated=false —
 *   nothing was escalated from, it was front-loaded).
 * - Otherwise the cheap lane runs and is verified. On a verify pass the result
 *   stands. On a verify failure the task escalates to the frontier, which is then
 *   verified (escalated=true, two attempts).
 *
 * Cost accumulates across every lane invocation. `finalLane` reflects the lane
 * whose result passed verification, or — if none passed — the last lane tried.
 */
export function runWithEscalation(
  task: TaskSignal,
  lanes: {
    cheap: (t: TaskSignal) => LaneResult;
    frontier: (t: TaskSignal) => LaneResult;
    verify: (r: LaneResult) => boolean;
  },
  policy: RouterPolicy = defaultRouterPolicy(),
): EscalationOutcome {
  const routed = classify(task, policy).lane;

  // Front-loaded frontier: classification put this on the frontier from the
  // start, so the cheap lane is never invoked.
  if (routed === 'frontier') {
    const r = lanes.frontier(task);
    return {
      passed: lanes.verify(r),
      finalLane: 'frontier',
      escalated: false,
      attempts: 1,
      costUnits: round6(r.costUnits),
    };
  }

  // Cheap-first path.
  const cheapResult = lanes.cheap(task);
  let cost = cheapResult.costUnits;
  if (lanes.verify(cheapResult)) {
    return {
      passed: true,
      finalLane: 'cheap',
      escalated: false,
      attempts: 1,
      costUnits: round6(cost),
    };
  }

  // Cheap verify failed → escalate to the frontier and verify it.
  const frontierResult = lanes.frontier(task);
  cost += frontierResult.costUnits;
  return {
    passed: lanes.verify(frontierResult),
    finalLane: 'frontier',
    escalated: true,
    attempts: 2,
    costUnits: round6(cost),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate metric: the headline number the benchmark optimizes.
// ─────────────────────────────────────────────────────────────────────────────

/** Total cost-units divided by the number of passing outcomes (0 passed → 0). */
export function costPerPass(outcomes: EscalationOutcome[]): number {
  const passed = outcomes.reduce((acc, o) => acc + (o.passed ? 1 : 0), 0);
  if (passed === 0) return 0;
  const total = outcomes.reduce((acc, o) => acc + o.costUnits, 0);
  return round6(total / passed);
}
