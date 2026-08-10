// @metaharness/turn-credit — the recursive belief update (ADR-248 §2).
//
//   B₀ = clip(prior, ε₀, 1−ε₀)          verifier-grounded initialization
//   c_k = γ·c_{k−1} + e_k               decayed evidence accumulation
//   ℓ_k = logit(B₀) + c_k               log-odds
//   B_k = σ(ℓ_k)                        belief in eventual success after turn k
//   ΔB_k = B_k − B_{k−1}                marginal belief revision (the credit signal)
//
// Pure and deterministic: no I/O, no clock, no randomness. All emitted values are
// round6'd so re-processing the same trace yields byte-identical artifacts.

import type { BeliefStep, TurnEvidence } from './types.js';

export function clip(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Round to 6 decimals — the workspace-wide convention for byte-stable artifacts.
 *  Normalizes −0 to +0 so canonical digests never depend on signed zero. */
export function round6(value: number): number {
  const r = Math.round(value * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

export function sigmoid(x: number): number {
  // Numerically stable in both tails.
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** Clip a raw prior (e.g. GRPO group success rate S/G) into (0,1) so logit is finite. */
export function clipPrior(prior: number, epsilon: number): number {
  return clip(prior, epsilon, 1 - epsilon);
}

/** Run the belief recursion over ordered per-turn evidence. `prior` must already
 *  be clipped (see {@link clipPrior}). The k=0 state is B₀ itself; the returned
 *  steps are k=1..K, one per evidence entry, in input order. */
export function beliefTrajectory(
  evidence: TurnEvidence[],
  prior: number,
  gamma: number,
): BeliefStep[] {
  const base = logit(prior);
  const steps: BeliefStep[] = [];
  let accumulated = 0;
  let previousBelief = prior;
  for (const e of evidence) {
    accumulated = gamma * accumulated + e.evidence;
    const logOdds = base + accumulated;
    const belief = sigmoid(logOdds);
    steps.push({
      turn: e.turn,
      evidence: round6(e.evidence),
      accumulated: round6(accumulated),
      logOdds: round6(logOdds),
      belief: round6(belief),
      revision: round6(belief - previousBelief),
    });
    previousBelief = belief;
  }
  return steps;
}
