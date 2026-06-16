// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { weightedMajority, borda } from '../src/consensus.js';

describe('weightedMajority', () => {
  it('sums weights per distinct value; highest wins', () => {
    const r = weightedMajority([
      { value: 'A', weight: 0.3 },
      { value: 'B', weight: 0.4 },
      { value: 'A', weight: 0.5 }, // A total 0.8 > B 0.4
    ]);
    expect(r.winner).toBe('A');
    expect(r.score).toBeCloseTo(0.8);
  });

  it('breaks ties toward the first-seen value (deterministic)', () => {
    const r = weightedMajority([
      { value: 'X', weight: 1 },
      { value: 'Y', weight: 1 },
    ]);
    expect(r.winner).toBe('X');
  });
});

describe('borda', () => {
  it('rewards broad agreement over a single loud first place', () => {
    // A is 1st once but last otherwise; B is consistently 2nd → B wins.
    const r = borda([
      { ranking: ['A', 'B', 'C'] },
      { ranking: ['B', 'C', 'A'] },
      { ranking: ['C', 'B', 'A'] },
    ]);
    // A: 2+0+0=2, B: 1+2+1=4, C: 0+1+2=3
    expect(r.winner).toBe('B');
    expect(r.tally.find((t) => t.value === 'C')?.score).toBe(3);
  });
});
