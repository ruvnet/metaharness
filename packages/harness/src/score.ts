// SPDX-License-Identifier: MIT
//
// The decision rule (ADR-047 key invariant).
//
//   decision = argmax utility(action)
//   utility  = quality − latency_cost − token_cost − risk_penalty + confidence_bonus
//
// And the four-gate guard: the harness never executes an action unless
//   confidence ≥ threshold ∧ risk ≤ budget ∧ cost ≤ budget ∧ verification == pass.

import type { Budget, WorkerOutput } from './types.js';

/** Tunable weights for the utility function. Defaults mirror the ADR's `score()`. */
export interface ScoringWeights {
  /** Penalty per second of latency. */
  latency: number;
  /** Penalty per USD of cost. */
  cost: number;
  /** Penalty per unit of risk (0..1). */
  risk: number;
  /** Bonus per unit of confidence (0..1). */
  confidence: number;
}

/** ADR-047 reference weights: quality − 0.15·latency_s − 4.0·cost − 2.5·risk + 0.5·conf. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  latency: 0.15,
  cost: 4.0,
  risk: 2.5,
  confidence: 0.5,
};

/**
 * The utility of accepting/executing a worker output. Higher is better; the
 * harness picks `argmax`. Latency is converted from ms to seconds to match the
 * ADR's `expectedLatencyMs / 1000`.
 */
export function score(o: WorkerOutput, w: ScoringWeights = DEFAULT_WEIGHTS): number {
  return (
    o.quality -
    w.latency * (o.latencyMs / 1000) -
    w.cost * o.costUsd -
    w.risk * o.risk +
    w.confidence * o.confidence
  );
}

/** The four gates, evaluated individually so callers can report *which* failed. */
export interface GateResult {
  ok: boolean;
  confidenceOk: boolean;
  riskOk: boolean;
  costOk: boolean;
  verificationOk: boolean;
  /** Reasons for any failed gate. */
  reasons: string[];
}

/**
 * The four-gate guard. `spentUsd` is run-to-date spend; the cost gate checks that
 * accepting this output keeps the run within `budget.costUsd`. `verified` is the
 * verifier verdict (pass/fail); pass an explicit value so an unverified action is
 * never silently executed.
 */
export function checkGates(
  o: WorkerOutput,
  budget: Budget,
  verified: boolean,
  spentUsd = 0,
): GateResult {
  const confidenceOk = o.confidence >= budget.confidence;
  const riskOk = o.risk <= budget.risk;
  const costOk = spentUsd + o.costUsd <= budget.costUsd;
  const verificationOk = verified === true;
  const reasons: string[] = [];
  if (!confidenceOk) reasons.push(`confidence ${o.confidence} < ${budget.confidence}`);
  if (!riskOk) reasons.push(`risk ${o.risk} > ${budget.risk}`);
  if (!costOk) reasons.push(`cost ${(spentUsd + o.costUsd).toFixed(4)} > ${budget.costUsd}`);
  if (!verificationOk) reasons.push('verification did not pass');
  return {
    ok: confidenceOk && riskOk && costOk && verificationOk,
    confidenceOk,
    riskOk,
    costOk,
    verificationOk,
    reasons,
  };
}

/** Convenience predicate: do all four gates pass? */
export function canExecute(o: WorkerOutput, budget: Budget, verified: boolean, spentUsd = 0): boolean {
  return checkGates(o, budget, verified, spentUsd).ok;
}
