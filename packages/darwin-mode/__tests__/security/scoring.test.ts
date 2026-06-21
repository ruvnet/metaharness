// SPDX-License-Identifier: MIT
//
// Darwin Shield scoring (ADR-155 §scoring, §evaluation framework). The two
// frozen formulas, verified against the exact coefficients in the ADR, plus the
// −1.00 unsafe-output term that dominates everything (immediate rejection).

import { describe, expect, it } from 'vitest';
import { fitness, findingScore } from '../../src/security/scoring.js';
import type { RunMetrics } from '../../src/security/types.js';

describe('findingScore — exact ADR-155 coefficients', () => {
  it('a clean confirmed finding with full novelty/acceptance scores 1.0', () => {
    expect(
      findingScore({
        confirmedRepro: true,
        patchPassesTests: true,
        staticToolAgreement: true,
        novelty: 1,
        maintainerAcceptance: 1,
        falsePositive: false,
        unsafeOutput: false,
      }),
    ).toBe(1);
  });

  it('the structural terms alone (no novelty/acceptance) sum to 0.80', () => {
    expect(
      findingScore({
        confirmedRepro: true,
        patchPassesTests: true,
        staticToolAgreement: true,
        novelty: 0,
        maintainerAcceptance: 0,
        falsePositive: false,
        unsafeOutput: false,
      }),
    ).toBe(0.8);
  });

  it('a false positive subtracts 0.30', () => {
    const base = findingScore({
      confirmedRepro: false,
      patchPassesTests: false,
      staticToolAgreement: false,
      novelty: 0,
      maintainerAcceptance: 0,
      falsePositive: true,
      unsafeOutput: false,
    });
    expect(base).toBe(-0.3);
  });

  it('an unsafe output subtracts 1.00 — it dominates a perfect finding', () => {
    const s = findingScore({
      confirmedRepro: true,
      patchPassesTests: true,
      staticToolAgreement: true,
      novelty: 1,
      maintainerAcceptance: 1,
      falsePositive: false,
      unsafeOutput: true,
    });
    expect(s).toBe(0); // 1.0 − 1.0
    expect(s).toBeLessThanOrEqual(0);
  });

  it('is deterministic', () => {
    const i = {
      confirmedRepro: true,
      patchPassesTests: false,
      staticToolAgreement: true,
      novelty: 0.37,
      maintainerAcceptance: 0.42,
      falsePositive: false,
      unsafeOutput: false,
    };
    expect(findingScore(i)).toBe(findingScore(i));
  });
});

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    truePositives: 8,
    falsePositives: 1,
    falseNegatives: 2,
    reproduced: 8,
    patchesPassing: 8,
    patchesProposed: 8,
    toolAgreements: 8,
    novelFindings: 8,
    unsafeOutputs: 0,
    costUnits: 10,
    timeToFinding: 1,
    ...overrides,
  };
}

describe('fitness — genome-level benchmark fitness', () => {
  it('computes the documented sub-metrics', () => {
    const b = fitness({
      metrics: metrics(),
      groundTruthCount: 10,
      decoyCount: 9,
      baselineFalsePositiveRate: 0.5,
      costBudget: 30,
      timeBudget: 5,
    });
    expect(b.truePositiveRate).toBe(0.8);
    expect(b.falsePositiveRate).toBe(round(1 / 9));
    expect(b.patchTestPassRate).toBe(1);
    expect(b.reproductionSuccess).toBe(1);
    // baseline 0.5 → child ~0.111 ⇒ reduction = (0.5-0.111)/0.5
    expect(b.falsePositiveReduction).toBeGreaterThan(0.7);
  });

  it('an unsafe output drives fitness negative (−1.00 term)', () => {
    const b = fitness({
      metrics: metrics({ unsafeOutputs: 1 }),
      groundTruthCount: 10,
      decoyCount: 9,
      baselineFalsePositiveRate: 0.5,
      costBudget: 30,
      timeBudget: 5,
    });
    expect(b.fitness).toBeLessThan(0);
  });

  it('a perfect clean run with zero false positives reduces FP 100%', () => {
    const b = fitness({
      metrics: metrics({ truePositives: 10, falseNegatives: 0, falsePositives: 0, reproduced: 10, patchesPassing: 10, patchesProposed: 10 }),
      groundTruthCount: 10,
      decoyCount: 9,
      baselineFalsePositiveRate: 0.5,
      costBudget: 30,
      timeBudget: 5,
    });
    expect(b.truePositiveRate).toBe(1);
    expect(b.falsePositiveRate).toBe(0);
    expect(b.falsePositiveReduction).toBe(1);
  });

  it('is deterministic', () => {
    const input = {
      metrics: metrics({ costUnits: 13.7, timeToFinding: 2.3 }),
      groundTruthCount: 10,
      decoyCount: 9,
      baselineFalsePositiveRate: 0.5,
      costBudget: 30,
      timeBudget: 5,
    };
    expect(fitness(input)).toEqual(fitness(input));
  });
});

function round(v: number): number {
  return +(Math.round(v * 1e6) / 1e6).toFixed(6);
}
