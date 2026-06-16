// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { score, checkGates, canExecute, DEFAULT_WEIGHTS } from '../src/score.js';
import { DEFAULT_BUDGET, type WorkerOutput } from '../src/types.js';

const good: WorkerOutput = { output: 'x', quality: 0.9, confidence: 0.8, risk: 0.1, costUsd: 0.01, latencyMs: 500 };

describe('score (utility invariant)', () => {
  it('rewards quality and confidence, penalises latency/cost/risk', () => {
    // 0.9 − 0.15*0.5 − 4*0.01 − 2.5*0.1 + 0.5*0.8 = 0.9 −0.075 −0.04 −0.25 +0.4
    expect(score(good, DEFAULT_WEIGHTS)).toBeCloseTo(0.935, 3);
  });
  it('a cheaper, lower-risk output scores higher than a dear, risky one of equal quality', () => {
    const cheap = { ...good, costUsd: 0.001, risk: 0.0 };
    const dear = { ...good, costUsd: 0.2, risk: 0.4 };
    expect(score(cheap)).toBeGreaterThan(score(dear));
  });
});

describe('checkGates (four-gate guard)', () => {
  it('passes when all four gates hold', () => {
    expect(canExecute(good, DEFAULT_BUDGET, true, 0)).toBe(true);
  });
  it('fails the confidence gate', () => {
    const g = checkGates({ ...good, confidence: 0.1 }, DEFAULT_BUDGET, true, 0);
    expect(g.ok).toBe(false);
    expect(g.confidenceOk).toBe(false);
  });
  it('fails the risk gate', () => {
    const g = checkGates({ ...good, risk: 0.9 }, DEFAULT_BUDGET, true, 0);
    expect(g.ok).toBe(false);
    expect(g.riskOk).toBe(false);
  });
  it('fails the cost gate when spend would exceed budget', () => {
    const g = checkGates({ ...good, costUsd: 0.5 }, DEFAULT_BUDGET, true, 0.7);
    expect(g.ok).toBe(false);
    expect(g.costOk).toBe(false);
  });
  it('fails the verification gate even when everything else is fine', () => {
    const g = checkGates(good, DEFAULT_BUDGET, false, 0);
    expect(g.ok).toBe(false);
    expect(g.verificationOk).toBe(false);
  });
});
