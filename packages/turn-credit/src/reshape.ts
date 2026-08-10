// @metaharness/turn-credit — outcome alignment + bounded reshaping (ADR-248 §3).
//
//   q_k = sign(A_seq)·ΔB_k                       align revision with the terminal outcome
//   z_k = (q_k − μ_q) / (σ_q + ε₀)               within-trajectory standardization
//   w_k = clip(1 + b·z_k, 1−b, 1+b)              bounded weight
//   m_k = (1−λ) + λ·w_k                          final multiplier; Ã_k = A_seq · m_k
//
// SAFETY INVARIANT (the reason this fits a governed flywheel): m_k ∈
// [1 − λ·b, 1 + λ·b] and is strictly positive for b < 1, so sign(Ã_k) =
// sign(A_seq) always — reshaping changes EMPHASIS across turns, it can never
// reverse the verifier's terminal decision. λ·b is exposed as `boundPct`
// (paper defaults → ±25%; GOVERNED_DEFAULTS → ±10%).

import { clip, round6 } from './belief.js';
import type { BeliefStep, CreditConfig, TurnCredit } from './types.js';

/** sign(A_seq) ∈ {−1, 0, +1}. A zero advantage yields zero credits everywhere. */
export function outcomeSign(advantage: number): number {
  return advantage > 0 ? 1 : advantage < 0 ? -1 : 0;
}

/** The guaranteed ceiling on per-turn advantage modulation, as a fraction of |A_seq|. */
export function effectiveBound(config: CreditConfig): number {
  return round6(config.mix * config.bound);
}

/** Turn belief steps into aligned, standardized, bounded per-turn credits. */
export function reshapeCredits(
  steps: BeliefStep[],
  advantage: number,
  config: CreditConfig,
  labels?: Map<number, string>,
): TurnCredit[] {
  const sign = outcomeSign(advantage);
  const q = steps.map((s) => sign * s.revision);
  const n = q.length;
  const mean = n > 0 ? q.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 0 ? q.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  const denom = Math.sqrt(variance) + config.priorEpsilon;
  return steps.map((s, i) => {
    const z = (q[i] - mean) / denom;
    const weight = clip(1 + config.bound * z, 1 - config.bound, 1 + config.bound);
    const multiplier = (1 - config.mix) + config.mix * weight;
    const label = labels?.get(s.turn);
    return {
      turn: s.turn,
      ...(label !== undefined ? { label } : {}),
      revision: s.revision,
      credit: round6(q[i]),
      z: round6(z),
      weight: round6(weight),
      multiplier: round6(multiplier),
      pivotal: false, // set by the processor once max|ΔB| is known
    };
  });
}

/** Pivotal turns: |ΔB_k| ≥ pivotalRatio · max_j|ΔB_j|, and strictly > 0. */
export function markPivotal(credits: TurnCredit[], pivotalRatio: number): number[] {
  const maxAbs = credits.reduce((a, c) => Math.max(a, Math.abs(c.revision)), 0);
  if (maxAbs === 0) return [];
  const threshold = pivotalRatio * maxAbs;
  const pivotal: number[] = [];
  for (const c of credits) {
    if (Math.abs(c.revision) >= threshold && Math.abs(c.revision) > 0) {
      c.pivotal = true;
      pivotal.push(c.turn);
    }
  }
  return pivotal;
}

/** Apply a turn's multiplier to the terminal advantage: Ã_k = A_seq · m_k. */
export function reshapedAdvantage(advantage: number, credit: TurnCredit): number {
  return round6(advantage * credit.multiplier);
}
