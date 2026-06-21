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

describe('StrategyMemory persistence (toJSON/fromJSON)', () => {
  it('round-trips losslessly: recall works after reload', async () => {
    const mem = new StrategyMemory();
    await runLearningLoop(targets, lane, { memory: mem, useMemory: true });
    // Recall hits + a recorded failure to exercise both counters in the snapshot.
    mem.recall('divzero');
    mem.recordFailure('oob');

    const json = mem.toJSON();
    const restored = StrategyMemory.fromJSON(json);

    // Strategies survive.
    expect(restored.export().map((s) => s.weaknessClass)).toEqual(['divzero', 'oob']);
    expect(restored.recall('divzero')).toEqual({ weaknessClass: 'divzero', hint: 'generalized-cue' });
    expect(restored.recall('oob')).toEqual({ weaknessClass: 'oob', hint: 'generalized-cue' });
    expect(restored.size()).toBe(2);
    // Counters survive (re-serialize matches once we account for the two recalls above).
    expect(StrategyMemory.fromJSON(json).failures('oob')).toBe(mem.failures('oob'));
    expect(StrategyMemory.fromJSON(json).uses('divzero')).toBe(mem.uses('divzero'));
    // Snapshot is stable: serializing the freshly-restored copy reproduces the bytes.
    expect(StrategyMemory.fromJSON(json).toJSON()).toBe(json);
  });
});

describe('StrategyMemory uses counter', () => {
  it('increments on each recall that returns a hit (not on misses)', () => {
    const mem = new StrategyMemory();
    mem.record({ weaknessClass: 'divzero', hint: 'cue' });
    expect(mem.uses('divzero')).toBe(0);
    mem.recall('divzero');
    mem.recall('divzero');
    expect(mem.uses('divzero')).toBe(2);
    // A miss does not increment any counter.
    mem.recall('never-seen');
    expect(mem.uses('never-seen')).toBe(0);
  });

  it('the loop drives the uses counter via recall on recurring classes', async () => {
    const mem = new StrategyMemory();
    await runLearningLoop(targets, lane, { memory: mem, useMemory: true });
    // divzero recalled on rounds #2,#3 after the first-of-class learns it; the
    // first-of-class round also recalls (a miss, no increment) — so 2 hits per class.
    expect(mem.uses('divzero')).toBe(2);
    expect(mem.uses('oob')).toBe(2);
  });
});

describe('StrategyMemory prune (decay)', () => {
  it('drops low-use strategies and stops recalling them', () => {
    const mem = new StrategyMemory();
    mem.record({ weaknessClass: 'hot', hint: 'cue' });
    mem.record({ weaknessClass: 'cold', hint: 'cue' });
    mem.recall('hot');
    mem.recall('hot'); // hot has 2 uses, cold has 0

    const dropped = mem.prune(1); // drop anything with uses < 1
    expect(dropped).toBe(1);
    expect(mem.recall('cold')).toBeUndefined();
    expect(mem.recall('hot')).toEqual({ weaknessClass: 'hot', hint: 'cue' });
    expect(mem.export().map((s) => s.weaknessClass)).toEqual(['hot']);
    expect(mem.size()).toBe(1);
  });
});

describe('StrategyMemory negative examples / distrust', () => {
  it('isDistrusted flips after maxFailures and the loop then treats the class as unassisted', async () => {
    const mem = new StrategyMemory();
    mem.record({ weaknessClass: 'flaky', hint: 'cue' });
    expect(mem.isDistrusted('flaky')).toBe(false);

    // Default maxFailures = 2 → distrust requires failures > 2 (i.e. 3+).
    mem.recordFailure('flaky');
    mem.recordFailure('flaky');
    expect(mem.failures('flaky')).toBe(2);
    expect(mem.isDistrusted('flaky')).toBe(false);
    mem.recordFailure('flaky');
    expect(mem.isDistrusted('flaky')).toBe(true);

    // A lane that is cheap ONLY when a cue is injected. The distrusted class must be
    // treated as unassisted (no cue), so the round pays the expensive price.
    const distrustLane: AttemptLane = ({ recalled }) => ({
      verified: true,
      weaknessClass: 'flaky',
      hint: 'generalized-cue',
      costUnits: recalled ? 1 : 10,
    });
    const r = await runLearningLoop(
      [{ id: 'flaky#9', weaknessClass: 'flaky' }],
      distrustLane,
      { memory: mem, useMemory: true },
    );
    expect(r.distrusted).toBe(1);
    expect(r.rounds[0].usedMemory).toBe(false); // cue suppressed
    expect(r.rounds[0].costUnits).toBe(10); // paid the unassisted price
  });

  it('a memory-assisted round that fails to verify records a failure', async () => {
    const mem = new StrategyMemory();
    mem.record({ weaknessClass: 'x', hint: 'cue' });
    // Lane that always fails to verify even with a recalled cue.
    const failLane: AttemptLane = () => ({ verified: false, costUnits: 5 });
    // Three same-class rounds: each recalls the (trusted) cue then fails → 3 failures.
    await runLearningLoop(
      [
        { id: 'x#1', weaknessClass: 'x' },
        { id: 'x#2', weaknessClass: 'x' },
        { id: 'x#3', weaknessClass: 'x' },
      ],
      failLane,
      { memory: mem, useMemory: true },
    );
    expect(mem.failures('x')).toBe(3);
    expect(mem.isDistrusted('x')).toBe(true);
  });
});
