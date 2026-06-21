// SPDX-License-Identifier: MIT
//
// Tests for discovery-evolve.ts — Darwin-style evolution over the discovery-harness
// POLICY. Fully deterministic and LLM-free: the policy evaluator is INJECTED as a
// mock whose fitness peaks at a known policy. We assert the loop converges to (or
// dominates) that optimum, the learning curve is monotone, the memo cache works
// (evaluatorCalls < evaluations), determinism (same seed ⇒ identical champion +
// receipt), and improvedOverBaseline when the baseline is weak.

import { describe, it, expect, vi } from 'vitest';
import {
  evolveDiscoveryPolicy,
  policyFitnessScalar,
  defaultVocabulary,
  defaultDiscoveryPolicy,
  type DiscoveryPolicy,
  type PolicyEvaluator,
  type PolicyFitness,
} from '../src/discovery-evolve.js';

// The optimum the mock rewards: skip statically-covered sites ON, a specific
// escalation cap (4 — high verified yield), the 'frontier-b' model and prompt
// variant 1. Cost grows with escalations, so fewer escalations is cheaper.
const OPTIMUM: DiscoveryPolicy = {
  cheapModel: 'cheap-a',
  frontierModel: 'frontier-b',
  maxEscalations: 4,
  skipStaticallyCovered: true,
  promptVariant: 1,
};

/**
 * Deterministic mock evaluator. More verified findings the closer the policy is to
 * OPTIMUM; cost rises with the escalation cap. The global fitness peak (verified per
 * cost) sits at OPTIMUM.
 */
const mockEvaluator: PolicyEvaluator = (p: DiscoveryPolicy): PolicyFitness => {
  let verified = 1; // a weak floor so cost is never divided into zero verified
  if (p.skipStaticallyCovered) verified += 6;
  // The escalation cap is the dominant verified driver: at the sweet spot the
  // frontier lane finds the most real weaknesses (the +12 bonus is large enough to
  // beat the cost penalty of more escalations, so the verified-per-cost peak truly
  // sits at OPTIMUM.maxEscalations rather than at the cheapest cap).
  if (p.maxEscalations === OPTIMUM.maxEscalations) verified += 12;
  if (p.frontierModel === OPTIMUM.frontierModel) verified += 2;
  if (p.promptVariant === OPTIMUM.promptVariant) verified += 1;
  // Cost scales with how many escalations the policy permits.
  const costUnits = 1 + p.maxEscalations * 0.5;
  return { verified, costUnits };
};

const weakBaseline: DiscoveryPolicy = {
  cheapModel: 'cheap-b',
  frontierModel: 'frontier-a',
  maxEscalations: 8, // most expensive
  skipStaticallyCovered: false, // misses the big verified bonus
  promptVariant: 2,
};

describe('policyFitnessScalar', () => {
  it('is verified per cost and higher is better', () => {
    expect(policyFitnessScalar({ verified: 10, costUnits: 2 })).toBe(5);
    expect(policyFitnessScalar({ verified: 10, costUnits: 5 })).toBe(2);
  });

  it('treats zero cost with positive verified as best (epsilon floor, not div-by-zero)', () => {
    const f = policyFitnessScalar({ verified: 1, costUnits: 0 });
    expect(Number.isFinite(f)).toBe(true);
    expect(f).toBeGreaterThan(policyFitnessScalar({ verified: 1, costUnits: 1 }));
  });
});

describe('evolveDiscoveryPolicy', () => {
  it('converges to (or dominates) the known optimum policy', () => {
    const res = evolveDiscoveryPolicy({
      evaluator: mockEvaluator,
      baseline: weakBaseline,
      generations: 12,
      population: 10,
      seed: 7,
    });
    const optimumFitness = policyFitnessScalar(mockEvaluator(OPTIMUM));
    // Champion fitness must reach the optimum (the only way to equal it is the
    // optimum's verified/cost; no other policy in the vocabulary beats it).
    expect(res.championFitness).toBeCloseTo(optimumFitness, 6);
    // The champion's decisive knobs match the optimum.
    expect(res.champion.skipStaticallyCovered).toBe(true);
    expect(res.champion.maxEscalations).toBe(OPTIMUM.maxEscalations);
    expect(res.champion.frontierModel).toBe(OPTIMUM.frontierModel);
    expect(res.champion.promptVariant).toBe(OPTIMUM.promptVariant);
  });

  it('history is monotone non-decreasing and ends >= it starts', () => {
    const res = evolveDiscoveryPolicy({
      evaluator: mockEvaluator,
      baseline: weakBaseline,
      generations: 12,
      population: 10,
      seed: 7,
    });
    expect(res.history.length).toBe(res.generations);
    for (let i = 1; i < res.history.length; i += 1) {
      expect(res.history[i]).toBeGreaterThanOrEqual(res.history[i - 1]);
    }
    expect(res.history[res.history.length - 1]).toBeGreaterThanOrEqual(res.history[0]);
  });

  it('memo cache works: evaluatorCalls < evaluations', () => {
    const spy = vi.fn(mockEvaluator);
    const res = evolveDiscoveryPolicy({
      evaluator: spy,
      baseline: weakBaseline,
      generations: 12,
      population: 10,
      seed: 7,
    });
    expect(res.evaluatorCalls).toBeLessThan(res.evaluations);
    // The injected evaluator is only invoked for cache misses.
    expect(spy).toHaveBeenCalledTimes(res.evaluatorCalls);
  });

  it('is deterministic: same seed => identical champion + receiptHash', () => {
    const a = evolveDiscoveryPolicy({
      evaluator: mockEvaluator,
      baseline: weakBaseline,
      generations: 12,
      population: 10,
      seed: 7,
    });
    const b = evolveDiscoveryPolicy({
      evaluator: mockEvaluator,
      baseline: weakBaseline,
      generations: 12,
      population: 10,
      seed: 7,
    });
    expect(b.champion).toEqual(a.champion);
    expect(b.championFitness).toBe(a.championFitness);
    expect(b.receiptHash).toBe(a.receiptHash);
    expect(b.history).toEqual(a.history);
  });

  it('different seeds still find the optimum but may explore differently', () => {
    const a = evolveDiscoveryPolicy({ evaluator: mockEvaluator, baseline: weakBaseline, generations: 16, population: 12, seed: 1 });
    const b = evolveDiscoveryPolicy({ evaluator: mockEvaluator, baseline: weakBaseline, generations: 16, population: 12, seed: 99 });
    const optimumFitness = policyFitnessScalar(mockEvaluator(OPTIMUM));
    expect(a.championFitness).toBeCloseTo(optimumFitness, 6);
    expect(b.championFitness).toBeCloseTo(optimumFitness, 6);
  });

  it('improvedOverBaseline is true when the baseline is weak', () => {
    const res = evolveDiscoveryPolicy({
      evaluator: mockEvaluator,
      baseline: weakBaseline,
      generations: 12,
      population: 10,
      seed: 7,
    });
    expect(res.improvedOverBaseline).toBe(true);
    expect(res.championFitness).toBeGreaterThan(res.baselineFitness);
  });

  it('improvedOverBaseline is false when the baseline is already optimal', () => {
    const res = evolveDiscoveryPolicy({
      evaluator: mockEvaluator,
      baseline: OPTIMUM,
      generations: 8,
      population: 8,
      seed: 3,
    });
    // No policy beats the optimum, so the champion ties the baseline (not strictly >).
    expect(res.improvedOverBaseline).toBe(false);
    expect(res.championFitness).toBeCloseTo(res.baselineFitness, 6);
  });

  it('default vocabulary and policy are well formed', () => {
    const v = defaultVocabulary();
    expect(v.cheapModels.length).toBeGreaterThan(0);
    expect(v.frontierModels.length).toBeGreaterThan(0);
    expect(v.maxEscalationChoices.length).toBeGreaterThan(0);
    expect(v.promptVariants.length).toBeGreaterThan(0);
    const p = defaultDiscoveryPolicy();
    expect(v.cheapModels).toContain(p.cheapModel);
    expect(v.frontierModels).toContain(p.frontierModel);
    expect(v.maxEscalationChoices).toContain(p.maxEscalations);
  });
});
