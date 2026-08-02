// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { Router, cosine, type RouterCandidate } from '../src/index.js';

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

// haiku is cheap and wins "stock" queries; opus is dear and wins "vaccine" queries.
const candidates: RouterCandidate[] = [
  {
    id: 'haiku',
    costPerMTok: 3,
    examples: [
      { embedding: [1, 0], quality: 0.9 },
      { embedding: [0.99, 0.1], quality: 0.88 },
      { embedding: [0, 1], quality: 0.5 },
    ],
  },
  {
    id: 'opus',
    costPerMTok: 45,
    examples: [
      { embedding: [1, 0], quality: 0.6 },
      { embedding: [0, 1], quality: 0.92 },
      { embedding: [0.1, 0.99], quality: 0.9 },
    ],
  },
];

describe('Router', () => {
  it('routes a stock-like query to the cheap winner (haiku)', () => {
    const r = new Router({ candidates, k: 1 });
    expect(r.route([1, 0]).id).toBe('haiku');
  });

  it('routes a vaccine-like query to the model that wins there (opus)', () => {
    const r = new Router({ candidates, k: 1 });
    expect(r.route([0, 1]).id).toBe('opus');
  });

  it('with a quality bar, picks the CHEAPEST candidate that clears it', () => {
    // On [1,0], haiku predicts 0.9 and opus 0.6. Bar 0.55 → both clear → cheapest = haiku.
    const r = new Router({ candidates, k: 1, qualityBar: 0.55 });
    const res = r.route([1, 0]);
    expect(res.id).toBe('haiku');
    expect(res.metBar).toBe(true);
  });

  it('when no candidate clears the bar, falls back to best-predicted', () => {
    const r = new Router({ candidates, k: 1, qualityBar: 0.99 });
    const res = r.route([1, 0]); // haiku 0.9 is the best, none clear 0.99
    expect(res.id).toBe('haiku');
    expect(res.metBar).toBe(false);
  });

  it('throws with no candidates', () => {
    expect(() => new Router({ candidates: [] })).toThrow(/at least one/);
  });

  it('predict() ranks a mismatched-length example by cosine()-over-shared-prefix, not by full-length norms', () => {
    // cosine()'s own na/nb accumulation only sums over the shared min-length
    // prefix — a 2-dim query against a 3-dim example with a huge trailing
    // component ignores that trailing component entirely, giving cosine([3,4],
    // [3,4,100]) = 1 (perfect match on the shared prefix). A norm computed
    // over each vector's own FULL length instead (the cached fast-path's
    // precondition) would let the trailing 100 dominate the example's norm
    // and crater its score to ~0.05 — flipping the k=1 winner to a worse,
    // same-length example. Assert the correct (flip-free) winner.
    const candidate: RouterCandidate = {
      id: 'x',
      costPerMTok: 1,
      examples: [
        { embedding: [3, 4, 100], quality: 1 }, // 3-dim: cosine-over-prefix = 1 (see above)
        { embedding: [0, 1], quality: 0 }, // 2-dim: cosine([3,4],[0,1]) = 0.8
      ],
    };
    const r = new Router({ candidates: [candidate], k: 1 });
    expect(cosine([3, 4], [3, 4, 100])).toBeCloseTo(1, 10);
    expect(r.predict(candidate, [3, 4])).toBe(1);
  });
});
