// SPDX-License-Identifier: MIT
//
// Darwin Shield metaproductivity lineage memory (ADR-155 Addendum B; HGM,
// arXiv:2510.21614). The Huxley–Gödel insight under test: the best PARENT is not
// the best current scorer — it is the variant whose DESCENDANTS improve fastest.
// ruVector cross-run seeding must prefer productive lineages over dead-end winners.

import { describe, expect, it } from 'vitest';
import { LineageMemory } from '../../src/security/memory.js';

describe('LineageMemory — metaproductivity ≠ raw fitness', () => {
  it('a low-scoring node with productive descendants beats a high-scoring dead end', () => {
    const lm = new LineageMemory();
    lm.record('A', null, 0.9); // high own score, no descendants (dead end)
    lm.record('B', null, 0.5); // low own score…
    lm.record('B1', 'B', 0.95); // …but a productive lineage
    lm.record('B2', 'B', 0.97);

    // Raw fitness would pick A over B.
    expect(0.9).toBeGreaterThan(0.5);
    // Metaproductivity flips it: B's descendants average 0.96 > A's 0.9.
    expect(lm.metaproductivity('B')).toBeGreaterThan(lm.metaproductivity('A'));
    expect(lm.metaproductivity('B')).toBe(0.96);
    expect(lm.metaproductivity('A')).toBe(0.9); // leaf ⇒ own fitness
  });

  it('a leaf reports its own fitness as metaproductivity (no evidence yet)', () => {
    const lm = new LineageMemory();
    lm.record('solo', null, 0.42);
    expect(lm.metaproductivity('solo')).toBe(0.42);
  });

  it('topByMetaproductivity differs from topByFitness when a parent is the better bet', () => {
    const lm = new LineageMemory();
    lm.record('deadend', null, 0.88); // best raw score, exhausted
    lm.record('seed', null, 0.4);
    lm.record('s1', 'seed', 0.9);
    lm.record('s2', 'seed', 0.93);
    lm.record('s3', 's1', 0.95);

    expect(lm.topByFitness(1)).toEqual(['s3']); // raw winner is a leaf
    // The seed lineage is the better PARENT to continue from (high descendant mean).
    expect(lm.metaproductivity('seed')).toBeGreaterThan(lm.metaproductivity('deadend'));
  });

  it('aggregates transitive descendants, not just direct children', () => {
    const lm = new LineageMemory();
    lm.record('root', null, 0.5);
    lm.record('c', 'root', 0.6);
    lm.record('gc', 'c', 1.0); // grandchild counts toward root's metaproductivity
    expect(lm.metaproductivity('root')).toBe(0.8); // mean(0.6, 1.0)
  });

  it('is deterministic and tracks size', () => {
    const lm = new LineageMemory();
    lm.record('x', null, 0.5);
    lm.record('y', 'x', 0.7);
    expect(lm.size()).toBe(2);
    expect(lm.metaproductivity('x')).toBe(lm.metaproductivity('x'));
  });
});
