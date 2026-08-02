import { describe, expect, it } from 'vitest';

import { meetsPromotionRule } from '../src/gate.js';
import {
  sequentialEvidence,
  withSequentialEvidence,
  type PairedOutcome,
} from '../src/sequential.js';
import type { PromotionEvidence, Score } from '../src/types.js';

const pair = (itemId: string, candidateWon: boolean, baselineWon: boolean): PairedOutcome => ({
  itemId,
  candidateWon,
  baselineWon,
});

/** n discordant pairs, all favoring the candidate. */
const candidateWins = (n: number): PairedOutcome[] =>
  Array.from({ length: n }, (_, i) => pair(`w${i}`, true, false));

const score = (over: Partial<Score> = {}): Score => ({
  primary: 0.5,
  noopRate: 0.5,
  costPerWin: 10,
  regressed: false,
  ...over,
});

describe('sequentialEvidence', () => {
  it('starts at 1 with no outcomes and is not significant', () => {
    const v = sequentialEvidence([]);
    expect(v.eValue).toBe(1);
    expect(v.significant).toBe(false);
    expect(v.threshold).toBe(20);
  });

  it('ignores concordant pairs entirely', () => {
    // Both arms winning (or both losing) says nothing about which is better.
    const v = sequentialEvidence([
      pair('a', true, true),
      pair('b', false, false),
      pair('c', true, true),
    ]);
    expect(v.eValue).toBe(1);
    expect(v.informativePairs).toBe(0);
    expect(v.totalPairs).toBe(3);
  });

  it('accumulates evidence only from discordant pairs', () => {
    const v = sequentialEvidence([
      pair('a', true, true), // concordant
      pair('b', true, false), // favors candidate
      pair('c', true, false), // favors candidate
    ]);
    expect(v.informativePairs).toBe(2);
    expect(v.eValue).toBeCloseTo(1.5 * 1.5, 10);
  });

  it('reaches significance after enough consistent wins', () => {
    // 1.5^n >= 20  =>  n >= 7.39, so 8 is the first significant count.
    expect(sequentialEvidence(candidateWins(7)).significant).toBe(false);
    expect(sequentialEvidence(candidateWins(8)).significant).toBe(true);
  });

  it('is driven back down by losses', () => {
    const v = sequentialEvidence([...candidateWins(8), pair('l1', false, true)]);
    expect(v.eValue).toBeCloseTo(1.5 ** 8 * 0.5, 10);
    expect(v.significant).toBe(false);
  });

  it('a coin-flip split does not reach significance', () => {
    // The property that matters: noise must not promote. Under the null,
    // P(ever crossing 1/alpha) <= alpha by Ville's inequality.
    const alternating = Array.from({ length: 200 }, (_, i) =>
      pair(`x${i}`, i % 2 === 0, i % 2 !== 0),
    );
    expect(sequentialEvidence(alternating).significant).toBe(false);
  });

  it('never crosses the threshold under a null sequence, however long', () => {
    // Peeking is free: this is checked at EVERY prefix, not just the end.
    const alternating = Array.from({ length: 500 }, (_, i) =>
      pair(`x${i}`, i % 2 === 0, i % 2 !== 0),
    );
    for (let n = 0; n <= alternating.length; n++) {
      expect(sequentialEvidence(alternating.slice(0, n)).significant).toBe(false);
    }
  });

  it('honours a stricter alpha', () => {
    const eight = candidateWins(8);
    expect(sequentialEvidence(eight, { alpha: 0.05 }).significant).toBe(true);
    expect(sequentialEvidence(eight, { alpha: 0.001 }).significant).toBe(false);
  });

  it('rejects out-of-range parameters instead of silently clamping', () => {
    expect(() => sequentialEvidence([], { alpha: 0 })).toThrow(RangeError);
    expect(() => sequentialEvidence([], { alpha: 1 })).toThrow(RangeError);
    expect(() => sequentialEvidence([], { lambda: 0 })).toThrow(RangeError);
    expect(() => sequentialEvidence([], { lambda: 1 })).toThrow(RangeError);
  });
});

describe('withSequentialEvidence', () => {
  const passingEvidence = (outcomes?: PairedOutcome[]): PromotionEvidence =>
    ({
      baseline: score(),
      candidate: score({ primary: 0.9, noopRate: 0.1, costPerWin: 5 }),
      ...(outcomes ? { pairedOutcomes: outcomes } : {}),
    }) as PromotionEvidence;

  it('degrades to the base rule when no paired outcomes are supplied', () => {
    // A caller that has not wired per-item outcomes yet must get the old
    // behaviour, not a permanently closed gate.
    const rule = withSequentialEvidence(meetsPromotionRule);
    expect(rule(passingEvidence()).promote).toBe(true);
  });

  it('blocks a candidate that clears the frozen gate on thin evidence', () => {
    const rule = withSequentialEvidence(meetsPromotionRule);
    const decision = rule(passingEvidence(candidateWins(3)));
    expect(meetsPromotionRule(passingEvidence(candidateWins(3))).promote).toBe(true);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.some((r) => r.startsWith('insufficient_sequential_evidence'))).toBe(
      true,
    );
  });

  it('promotes when both the frozen gate and the evidence agree', () => {
    const rule = withSequentialEvidence(meetsPromotionRule);
    expect(rule(passingEvidence(candidateWins(8))).promote).toBe(true);
  });

  it('never promotes something the base rule rejected, however strong the evidence', () => {
    // Composition must be conjunctive: evidence cannot buy its way past a
    // safety regression or a cost blowout.
    const rule = withSequentialEvidence(meetsPromotionRule);
    const regressed = {
      baseline: score(),
      candidate: score({ primary: 0.9, noopRate: 0.1, regressed: true }),
      pairedOutcomes: candidateWins(50),
    } as PromotionEvidence;
    const decision = rule(regressed);
    expect(decision.promote).toBe(false);
    expect(decision.reasons).toContain('safety_regressed');
  });

  it('preserves the base rule reasons alongside its own', () => {
    const rule = withSequentialEvidence(meetsPromotionRule);
    const noopNotImproved = {
      baseline: score(),
      candidate: score({ primary: 0.9, noopRate: 0.5 }),
      pairedOutcomes: candidateWins(2),
    } as PromotionEvidence;
    const decision = rule(noopNotImproved);
    expect(decision.reasons).toContain('noop_rate_not_improved');
    expect(decision.reasons.some((r) => r.startsWith('insufficient_sequential_evidence'))).toBe(
      true,
    );
  });
});
