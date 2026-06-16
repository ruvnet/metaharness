// SPDX-License-Identifier: MIT
//
// Consensus layer (ADR-047): merge multiple worker outputs into one answer via
// weighted majority or Borda count. Used when the algorithm router fans a step
// out to several agents and the harness must reconcile their proposals.

/** One agent's vote: a value plus a weight (e.g. its predicted quality/confidence). */
export interface Vote<T> {
  value: T;
  weight: number;
}

export interface ConsensusResult<T> {
  winner: T;
  /** The winning value's total score under the chosen rule. */
  score: number;
  /** Every distinct value with its aggregated score, descending. */
  tally: { value: T; score: number }[];
}

/** Stable string key for grouping equal values (JSON form). */
function keyOf(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Weighted majority: sum each distinct value's weights; highest total wins. Ties
 * break toward the value first seen, so the result is deterministic.
 */
export function weightedMajority<T>(votes: Vote<T>[]): ConsensusResult<T> {
  if (!votes.length) throw new Error('weightedMajority needs at least one vote');
  const scores = new Map<string, { value: T; score: number; order: number }>();
  votes.forEach((v, i) => {
    const k = keyOf(v.value);
    const cur = scores.get(k);
    if (cur) cur.score += v.weight;
    else scores.set(k, { value: v.value, score: v.weight, order: i });
  });
  return finalize(scores);
}

/**
 * Borda count: each agent submits a ranked ballot (best first). A candidate gets
 * (n−rank−1) points per ballot, weighted by the ballot's weight. Rewards broad
 * agreement over a single loud vote.
 */
export function borda<T>(ballots: { ranking: T[]; weight?: number }[]): ConsensusResult<T> {
  if (!ballots.length) throw new Error('borda needs at least one ballot');
  const scores = new Map<string, { value: T; score: number; order: number }>();
  let order = 0;
  for (const ballot of ballots) {
    const w = ballot.weight ?? 1;
    const n = ballot.ranking.length;
    ballot.ranking.forEach((value, rank) => {
      const k = keyOf(value);
      const pts = (n - rank - 1) * w;
      const cur = scores.get(k);
      if (cur) cur.score += pts;
      else scores.set(k, { value, score: pts, order: order++ });
    });
  }
  return finalize(scores);
}

function finalize<T>(scores: Map<string, { value: T; score: number; order: number }>): ConsensusResult<T> {
  const sorted = [...scores.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    winner: sorted[0].value,
    score: sorted[0].score,
    tally: sorted.map(({ value, score }) => ({ value, score })),
  };
}
