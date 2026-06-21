// SPDX-License-Identifier: MIT
//
// Tests for opportunity.ts (ADR-165 Darwin Opportunity Scanner): ranking
// determinism, ROI ordering (high spend + strong verification beats low value +
// weak verification), top-N completeness/bounds, and verification-method thresholds.

import { describe, it, expect } from 'vitest';
import {
  scoreOpportunity,
  rankOpportunities,
  type OpportunityInput,
  type VerificationMethod,
} from '../src/opportunity.js';

/** Build an input with sensible defaults, overridable per field. */
function input(over: Partial<OpportunityInput> & { taskClass: string }): OpportunityInput {
  return {
    monthlyVolume: 1000,
    modelSpendUnitsPerTask: 1,
    verificationStrength: 0.6,
    failureRisk: 0.1,
    modelComplexity: 0.3,
    testability: 0.7,
    ...over,
  };
}

/** A synthetic portfolio of varied task classes for completeness checks. */
function portfolio(): OpportunityInput[] {
  return Array.from({ length: 12 }, (_, i) =>
    input({
      taskClass: `task-${i}`,
      monthlyVolume: 100 + i * 250,
      modelSpendUnitsPerTask: 0.5 + (i % 5) * 0.7,
      verificationStrength: (i % 5) / 4, // 0, .25, .5, .75, 1
      failureRisk: ((i * 3) % 10) / 10,
      modelComplexity: ((i * 7) % 10) / 10,
      testability: ((i * 5) % 10) / 10,
    }),
  );
}

describe('opportunity ranking determinism', () => {
  it('same input yields the same order and ranks', () => {
    const a = rankOpportunities(portfolio());
    const b = rankOpportunities(portfolio());
    expect(a.map((x) => x.taskClass)).toEqual(b.map((x) => x.taskClass));
    expect(a.map((x) => x.roi)).toEqual(b.map((x) => x.roi));
    expect(a.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('input order does not change the ranking (stable, content-based)', () => {
    const items = portfolio();
    const reversed = [...items].reverse();
    const a = rankOpportunities(items).map((x) => x.taskClass);
    const b = rankOpportunities(reversed).map((x) => x.taskClass);
    expect(a).toEqual(b);
  });
});

describe('opportunity ROI ordering', () => {
  it('high spend + strong verification ranks above low value + weak verification', () => {
    const strong = input({
      taskClass: 'high-value',
      monthlyVolume: 5000,
      modelSpendUnitsPerTask: 3,
      verificationStrength: 0.95,
      failureRisk: 0.05,
      modelComplexity: 0.2,
      testability: 0.9,
    });
    const weak = input({
      taskClass: 'low-value',
      monthlyVolume: 50,
      modelSpendUnitsPerTask: 0.2,
      verificationStrength: 0.1,
      failureRisk: 0.6,
      modelComplexity: 0.8,
      testability: 0.2,
    });
    const ranked = rankOpportunities([weak, strong]);
    expect(ranked[0].taskClass).toBe('high-value');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].roi).toBeGreaterThan(ranked[1].roi);
  });
});

describe('opportunity top-N completeness and bounds', () => {
  it('every score has finite cost>=0, saving in [0,cost], valid method, risk in [0,1]', () => {
    const methods: VerificationMethod[] = ['real-oracle', 'unit-tests', 'human-review', 'none'];
    const ranked = rankOpportunities(portfolio());
    const top = ranked.slice(0, 10);
    expect(top.length).toBe(10);
    for (const s of top) {
      expect(Number.isFinite(s.estimatedMonthlyCost)).toBe(true);
      expect(s.estimatedMonthlyCost).toBeGreaterThanOrEqual(0);
      expect(s.expectedSaving).toBeGreaterThanOrEqual(0);
      expect(s.expectedSaving).toBeLessThanOrEqual(s.estimatedMonthlyCost);
      expect(methods).toContain(s.verificationMethod);
      expect(s.riskScore).toBeGreaterThanOrEqual(0);
      expect(s.riskScore).toBeLessThanOrEqual(1);
    }
  });
});

describe('opportunity verification-method thresholds', () => {
  it('maps verificationStrength to the correct method', () => {
    const at = (v: number): VerificationMethod =>
      scoreOpportunity(input({ taskClass: 't', verificationStrength: v })).verificationMethod;
    expect(at(0.8)).toBe('real-oracle');
    expect(at(0.95)).toBe('real-oracle');
    expect(at(0.79)).toBe('unit-tests');
    expect(at(0.5)).toBe('unit-tests');
    expect(at(0.49)).toBe('human-review');
    expect(at(0.2)).toBe('human-review');
    expect(at(0.19)).toBe('none');
    expect(at(0)).toBe('none');
  });
});
