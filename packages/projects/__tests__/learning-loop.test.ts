// SPDX-License-Identifier: MIT
//
// Tests for learning-loop.ts — the self-learning discovery loop. Deterministic:
// the attempt lane is a mock that is CHEAP when a strategy is recalled (the loop
// has learned this weakness class) and EXPENSIVE otherwise. With recurring classes,
// memory-on must cost strictly less than memory-off — that IS the learning signal.

import { describe, it, expect } from 'vitest';
import { runLearningLoop, StrategyMemory, type LoopTarget, type AttemptLane } from '../src/learning-loop.js';

// First encounter of a class: expensive (10) but verified and yields a hint.
// Later encounters WITH a recalled strategy: cheap (1). Without recall: expensive.
const lane: AttemptLane = ({ target, recalled }) => ({
  verified: true,
  weaknessClass: target.split('#')[0],
  hint: 'generalized-cue',
  costUnits: recalled ? 1 : 10,
});

// 6 targets across 2 recurring weakness classes.
const targets: LoopTarget[] = [
  { id: 'divzero#1', weaknessClass: 'divzero' },
  { id: 'oob#1', weaknessClass: 'oob' },
  { id: 'divzero#2', weaknessClass: 'divzero' },
  { id: 'divzero#3', weaknessClass: 'divzero' },
  { id: 'oob#2', weaknessClass: 'oob' },
  { id: 'oob#3', weaknessClass: 'oob' },
];

describe('runLearningLoop', () => {
  it('learns: memory-on costs strictly less than memory-off on recurring classes', async () => {
    const on = await runLearningLoop(targets, lane, { useMemory: true });
    const off = await runLearningLoop(targets, lane, { useMemory: false });
    expect(on.verified).toBe(6);
    expect(off.verified).toBe(6);
    // memory-off pays full price every time: 6*10 = 60. memory-on: 2 first-of-class
    // at 10 + 4 recalled at 1 = 24.
    expect(off.totalCost).toBe(60);
    expect(on.totalCost).toBe(24);
    expect(on.totalCost).toBeLessThan(off.totalCost);
  });

  it('records one strategy per weakness class', async () => {
    const mem = new StrategyMemory();
    const r = await runLearningLoop(targets, lane, { memory: mem, useMemory: true });
    expect(r.memorySize).toBe(2); // divzero, oob
    expect(mem.export().map((s) => s.weaknessClass)).toEqual(['divzero', 'oob']);
  });

  it('assisted rounds are cheaper than unassisted (the learning signal)', async () => {
    const r = await runLearningLoop(targets, lane, { useMemory: true });
    expect(r.costWithoutMemory).toBe(10); // first-of-class rounds
    expect(r.costWithMemory).toBe(1); // recalled rounds
    expect(r.costWithMemory).toBeLessThan(r.costWithoutMemory);
  });

  it('cost-per-verified improves with memory', async () => {
    const on = await runLearningLoop(targets, lane, { useMemory: true });
    const off = await runLearningLoop(targets, lane, { useMemory: false });
    expect(on.costPerVerified).toBe(4); // 24/6
    expect(off.costPerVerified).toBe(10); // 60/6
    expect(on.costPerVerified).toBeLessThan(off.costPerVerified);
  });

  it('is deterministic and order-faithful', async () => {
    const a = await runLearningLoop(targets, lane);
    const b = await runLearningLoop(targets, lane);
    expect(a.rounds).toEqual(b.rounds);
    // first occurrence of each class is unassisted; subsequent are assisted.
    expect(a.rounds.map((r) => r.usedMemory)).toEqual([false, false, true, true, true, true]);
  });
});
