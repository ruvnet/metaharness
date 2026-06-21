// SPDX-License-Identifier: MIT
//
// Tests for memory-tiers.ts (ADR-161 ruVector Memory Tiers).

import { describe, expect, it } from 'vitest';
import {
  TieredMemory,
  defaultDepthPolicy,
  depthFor,
  simulateRun,
  type MemTask,
  type MemoryTier,
} from '../src/memory-tiers.js';

describe('TieredMemory isolation', () => {
  it('(1) same key in two tiers holds different values; wrong tier is undefined', () => {
    const m = new TieredMemory();
    m.put('working', 'ctx', 'working-value');
    m.put('repo', 'ctx', 'repo-value');

    expect(m.get('working', 'ctx')).toBe('working-value');
    expect(m.get('repo', 'ctx')).toBe('repo-value');
    // A key in `mutation` was never set — invisible across tiers.
    expect(m.get('mutation', 'ctx')).toBeUndefined();
    expect(m.size('working')).toBe(1);
    expect(m.size('repo')).toBe(1);
    expect(m.size()).toBe(2);
  });
});

describe('TieredMemory.search', () => {
  it('(2) ranks by deterministic token overlap and is reproducible', () => {
    const build = () => {
      const m = new TieredMemory();
      m.put('repo', 'load repo context for auth module', 1);
      m.put('repo', 'auth module token refresh', 2);
      m.put('repo', 'unrelated billing invoice', 3);
      return m.search<number>('repo', 'auth module', 3);
    };
    const a = build();
    const b = build();
    expect(a.map((h) => h.key)).toEqual(b.map((h) => h.key));
    // The closest key ("auth module token refresh") ranks first.
    expect(a[0].key).toBe('auth module token refresh');
    // Scores are non-increasing.
    for (let i = 1; i < a.length; i += 1) {
      expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
    }
    // Search stays within the tier — nothing leaks from an empty `risk` tier.
    expect(build().every((h) => typeof h.value === 'number')).toBe(true);
  });
});

describe('simulateRun A/B (memory never lowers solve rate)', () => {
  const suite: MemTask[] = [
    { id: 't1', taskClass: 'repo-bound', baseTokens: 10000, solvableWithMemory: true },
    { id: 't2', taskClass: 'refactor', baseTokens: 8000, solvableWithMemory: false },
    { id: 't3', taskClass: 'greenfield', baseTokens: 6000, solvableWithMemory: true },
    { id: 't4', taskClass: 'security', baseTokens: 7000, solvableWithMemory: false },
    { id: 't5', taskClass: 'repo-bound', baseTokens: 12000, solvableWithMemory: false },
  ];

  it('(3) memoryOn uses fewer tokens and solves >= memoryOff', () => {
    const depth = defaultDepthPolicy();
    const off = simulateRun(suite, { memoryOn: false, depth, seed: 42 });
    const on = simulateRun(suite, { memoryOn: true, depth, seed: 42 });

    expect(on.totalTokens).toBeLessThan(off.totalTokens);
    expect(on.solved).toBeGreaterThanOrEqual(off.solved);
    expect(on.tokensSavedPct).toBeGreaterThan(0);
    expect(off.tokensSavedPct).toBe(0);
  });

  it('is deterministic for a fixed seed', () => {
    const depth = defaultDepthPolicy();
    const r1 = simulateRun(suite, { memoryOn: true, depth, seed: 7 });
    const r2 = simulateRun(suite, { memoryOn: true, depth, seed: 7 });
    expect(r1).toEqual(r2);
  });
});

describe('depthFor', () => {
  it('(4) returns the expected tiers per task class', () => {
    const p = defaultDepthPolicy();
    const eq = (a: MemoryTier[], b: MemoryTier[]) => expect(a).toEqual(b);
    eq(depthFor(p, 'repo-bound'), ['working', 'repo', 'mutation', 'cost', 'risk']);
    eq(depthFor(p, 'greenfield'), ['working']);
    eq(depthFor(p, 'security'), ['working', 'risk', 'repo']);
    eq(depthFor(p, 'refactor'), ['working', 'repo']);
  });
});
