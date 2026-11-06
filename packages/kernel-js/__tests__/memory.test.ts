// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { rankWithDecay, linearDecay, type MemoryHit } from '../src/memory.js';

describe('linearDecay', () => {
  it('returns 1 at age 0', () => {
    expect(linearDecay(0, 1000)).toBe(1);
  });
  it('returns 0.5 at one half-life', () => {
    expect(linearDecay(1000, 1000)).toBeCloseTo(0.5);
  });
  it('returns 0.25 at two half-lives', () => {
    expect(linearDecay(2000, 1000)).toBeCloseTo(0.25);
  });
  it('clamps negative ages to weight 1', () => {
    expect(linearDecay(-5, 1000)).toBe(1);
  });
});

describe('rankWithDecay', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const NOW = 1_700_000_000_000;

  const hits: MemoryHit[] = [
    { id: 'a', score: 0.9, decayedScore: 0, namespace: 'ns', storedAt: NOW - 30 * DAY },
    { id: 'b', score: 0.8, decayedScore: 0, namespace: 'ns', storedAt: NOW - 1 * HOUR },
    { id: 'c', score: 0.6, decayedScore: 0, namespace: 'ns', storedAt: NOW - 7 * DAY },
  ];

  it('falls back to raw score when useDecay is false', async () => {
    const r = await rankWithDecay(hits, { useDecay: false });
    expect(r.map(h => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('decays by storedAt with the half-life weight and reorders', async () => {
    // @ruvector/emergent-time 0.1.x has no weight(ageMs), so this is the
    // deterministic 0.5^(age / halfLife) path.
    const r = await rankWithDecay(hits, { useDecay: true, now: NOW, halfLifeMs: 7 * DAY });
    expect(r.map(h => h.id)).toEqual(['b', 'c', 'a']);
    for (const h of r) {
      const age = NOW - h.storedAt!;
      expect(h.decayedScore).toBeCloseTo(h.score * linearDecay(age, 7 * DAY), 10);
      expect(h.decayedScore).toBeGreaterThan(0);
    }
    // score stays the raw similarity.
    expect(r.find(h => h.id === 'a')!.score).toBe(0.9);
  });

  it('treats hits without storedAt as age 0', async () => {
    const r = await rankWithDecay(
      [{ id: 'x', score: 0.5, decayedScore: 0, namespace: 'ns' }],
      { useDecay: true, now: NOW },
    );
    expect(r[0].decayedScore).toBe(0.5);
  });

  it('sorts descending by the ranking key', async () => {
    const r = await rankWithDecay(hits, { useDecay: false });
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
    }
  });
});
