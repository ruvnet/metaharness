// SPDX-License-Identifier: MIT
//
// Darwin Shield genome (ADR-155 §genome, §mutation operators). The invariant
// under test: every mutation stays inside the safe envelope and never touches the
// strict-defensive safety profile — no matter how many times it is applied.

import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  BOUNDS,
  baselineGenome,
  crossover,
  isGenomeValid,
  mutate,
  seedPopulation,
} from '../../src/security/genome.js';
import { makeRng } from '../../src/security/util.js';

describe('mutate — stays inside the safe envelope', () => {
  it('keeps every knob in bounds across 2000 mutations from many seeds', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const rng = makeRng(seed);
      let g = baselineGenome();
      for (let i = 0; i < 40; i += 1) {
        g = mutate(g, rng, 1, i);
        expect(isGenomeValid(g)).toBe(true);
        expect(g.reviewerCount).toBeGreaterThanOrEqual(BOUNDS.reviewerCount[0]);
        expect(g.reviewerCount).toBeLessThanOrEqual(BOUNDS.reviewerCount[1]);
        expect(g.retryBudget).toBeGreaterThanOrEqual(BOUNDS.retryBudget[0]);
        expect(g.retryBudget).toBeLessThanOrEqual(BOUNDS.retryBudget[1]);
        expect(g.fuzzBudgetSeconds).toBeGreaterThanOrEqual(BOUNDS.fuzzBudgetSeconds[0]);
        expect(g.fuzzBudgetSeconds).toBeLessThanOrEqual(BOUNDS.fuzzBudgetSeconds[1]);
        expect(g.tools.length).toBeGreaterThan(0);
        expect(g.safetyProfile).toBe('strict-defensive');
      }
    }
  });

  it('never lets the toolset go empty', () => {
    const rng = makeRng(7);
    let g = { ...baselineGenome(), tools: [ALL_TOOLS[0]] };
    for (let i = 0; i < 100; i += 1) {
      g = mutate(g, rng, 1, i);
      expect(g.tools.length).toBeGreaterThan(0);
    }
  });

  it('records the parent id (lineage)', () => {
    const g = mutate(baselineGenome(), makeRng(1), 1, 0);
    expect(g.parentId).toBe('baseline');
  });

  it('is deterministic for a fixed seed', () => {
    const a = mutate(baselineGenome(), makeRng(42), 1, 0);
    const b = mutate(baselineGenome(), makeRng(42), 1, 0);
    expect({ ...a, id: '' }).toEqual({ ...b, id: '' });
  });
});

describe('crossover — child inherits from both parents, stays valid', () => {
  it('produces a valid genome inside the envelope', () => {
    const rng = makeRng(3);
    const a = mutate(baselineGenome(), rng, 1, 0);
    const b = mutate(baselineGenome(), rng, 1, 1);
    for (let i = 0; i < 50; i += 1) {
      const child = crossover(a, b, rng, 2, i);
      expect(isGenomeValid(child)).toBe(true);
      expect(child.safetyProfile).toBe('strict-defensive');
    }
  });
});

describe('seedPopulation', () => {
  it('returns exactly the requested size with the base first', () => {
    const pop = seedPopulation(baselineGenome(), 16, 0);
    expect(pop).toHaveLength(16);
    expect(pop[0].id).toBe('baseline');
    expect(pop.every(isGenomeValid)).toBe(true);
  });

  it('prefixes supplied seed genomes (genome memory)', () => {
    const seedG = { ...baselineGenome(), id: 'prior-winner', reviewerCount: 5 };
    const pop = seedPopulation(baselineGenome(), 8, 0, [seedG]);
    expect(pop).toHaveLength(8);
    expect(pop.map((g) => g.id)).toContain('prior-winner');
  });

  it('is deterministic for a fixed seed', () => {
    const a = seedPopulation(baselineGenome(), 8, 5).map((g) => ({ ...g, id: '' }));
    const b = seedPopulation(baselineGenome(), 8, 5).map((g) => ({ ...g, id: '' }));
    expect(a).toEqual(b);
  });
});

describe('isGenomeValid — rejects out-of-envelope genomes', () => {
  it('rejects a tampered safety profile', () => {
    const g = { ...baselineGenome(), safetyProfile: 'offensive' as unknown as 'strict-defensive' };
    expect(isGenomeValid(g)).toBe(false);
  });
  it('rejects out-of-range reviewer count', () => {
    expect(isGenomeValid({ ...baselineGenome(), reviewerCount: 9 })).toBe(false);
  });
  it('rejects an empty toolset', () => {
    expect(isGenomeValid({ ...baselineGenome(), tools: [] })).toBe(false);
  });
});
