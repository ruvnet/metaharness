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
});
