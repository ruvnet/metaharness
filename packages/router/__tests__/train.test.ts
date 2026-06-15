// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { solve, fitKRR, trainRouter, TrainedRouter } from '../src/train.js';

describe('solve (Gaussian elimination)', () => {
  it('solves a 2x2 system', () => {
    // 2x + y = 5 ; x + 3y = 10  → x=1, y=3
    const x = solve([[2, 1], [1, 3]], [5, 10]);
    expect(x[0]).toBeCloseTo(1, 6);
    expect(x[1]).toBeCloseTo(3, 6);
  });
  it('solves identity', () => {
    expect(solve([[1, 0], [0, 1]], [4, 7])).toEqual([4, 7]);
  });
});

describe('fitKRR', () => {
  it('returns one coefficient per training example', () => {
    const X = [[1, 0], [0, 1], [1, 1]];
    const alpha = fitKRR(X, [0.9, 0.5, 0.7], 0.1);
    expect(alpha).toHaveLength(3);
    expect(alpha.every((a) => Number.isFinite(a))).toBe(true);
  });
});

describe('trainRouter — KRR cost-optimal router', () => {
  // "stock"-like queries near [1,0] (haiku wins); "vaccine"-like near [0,1] (opus wins).
  const rows = [
    { embedding: [1, 0], scores: { haiku: 0.9, opus: 0.6 } },
    { embedding: [0.95, 0.05], scores: { haiku: 0.88, opus: 0.62 } },
    { embedding: [0.9, 0.1], scores: { haiku: 0.86, opus: 0.6 } },
    { embedding: [0, 1], scores: { haiku: 0.5, opus: 0.92 } },
    { embedding: [0.05, 0.95], scores: { haiku: 0.52, opus: 0.9 } },
    { embedding: [0.1, 0.9], scores: { haiku: 0.55, opus: 0.9 } },
  ];
  const prices = { haiku: 3, opus: 45 };

  it('learns to route each cluster to its winner', () => {
    const { router, lambda, looQuality } = trainRouter(rows, prices);
    expect(lambda).toBeGreaterThan(0);
    expect(looQuality).toBeGreaterThan(0.7); // routes well on held-out
    expect(router.route([1, 0]).id).toBe('haiku');
    expect(router.route([0, 1]).id).toBe('opus');
  });

  it('with a quality bar, prefers the cheaper model when it clears the bar', () => {
    // On a stock query haiku predicts ~0.9 (clears 0.55) and is cheaper → haiku.
    const { router } = trainRouter(rows, prices, { qualityBar: 0.55 });
    const r = router.route([1, 0]);
    expect(r.id).toBe('haiku');
    expect(r.metBar).toBe(true);
  });

  it('serialises and reloads to the same routing', () => {
    const { router } = trainRouter(rows, prices);
    const reloaded = TrainedRouter.fromJSON(JSON.parse(JSON.stringify(router.toJSON())));
    expect(reloaded.route([1, 0]).id).toBe(router.route([1, 0]).id);
    expect(reloaded.route([0, 1]).id).toBe(router.route([0, 1]).id);
  });
});
