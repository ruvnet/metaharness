// SPDX-License-Identifier: MIT
//
// Tests for checkpoints.ts (ADR-157 Darwin Checkpoints).

import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../src/core.js';
import {
  CallCache,
  CheckpointStore,
  runWithCheckpoints,
  type RunStep,
} from '../src/checkpoints.js';

const RUN_ID = 'run-A';
const GENOME = 'g-1';
const STEP_MODEL_CALLS = 1;

/** Ten deterministic steps; each issues one model call and advances state. */
function makeSteps(n = 10): RunStep[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `step-${i}`,
    run: (ctx) => {
      const priorN = typeof ctx.prior === 'number' ? ctx.prior : 0;
      return {
        state: priorN + (i + 1),
        result: `r${i}`,
        fitnessDelta: i + 1,
        modelCalls: STEP_MODEL_CALLS,
        toolCalls: 2,
        costUnits: i + 1, // monotonically more expensive
      };
    },
  }));
}

describe('runWithCheckpoints', () => {
  it('(1) uninterrupted run produces a fitness F and total model calls M', () => {
    const out = runWithCheckpoints({
      runId: RUN_ID,
      genomeId: GENOME,
      steps: makeSteps(10),
      policy: defaultPolicy(),
    });
    expect(out.completed).toBe(true);
    expect(out.checkpoints).toHaveLength(10);
    expect(out.fitness).toBe(55); // 1+2+...+10
    expect(out.modelCallsIssued).toBe(10);
    expect(out.resumedFrom).toBe(0);
  });

  it('(2) crash-and-resume matches the uninterrupted run with zero duplicate model calls', () => {
    // Baseline uninterrupted run.
    const baseline = runWithCheckpoints({
      runId: RUN_ID,
      genomeId: GENOME,
      steps: makeSteps(10),
      policy: defaultPolicy(),
    });
    const finalHashBaseline = baseline.checkpoints[baseline.checkpoints.length - 1].hash;

    // Fresh store + shared cache; crash after step 5.
    const store = new CheckpointStore();
    const cache = new CallCache();
    const crashed = runWithCheckpoints({
      runId: RUN_ID,
      genomeId: GENOME,
      steps: makeSteps(10),
      policy: defaultPolicy(),
      store,
      cache,
      crashAfter: 5,
    });
    expect(crashed.completed).toBe(false);
    expect(crashed.checkpoints).toHaveLength(6); // steps 0..5 persisted
    expect(crashed.modelCallsIssued).toBe(6);

    // Resume from the SAME store (new cache to prove we don't re-issue calls).
    const resumed = runWithCheckpoints({
      runId: RUN_ID,
      genomeId: GENOME,
      steps: makeSteps(10),
      policy: defaultPolicy(),
      store,
      cache: new CallCache(),
    });
    expect(resumed.completed).toBe(true);
    expect(resumed.resumedFrom).toBe(6); // skipped checkpointed steps 0..5
    // Only steps 6..9 issue model calls on resume → zero duplicates for 0..5.
    expect(resumed.modelCallsIssued).toBe(4);
    expect(resumed.fitness).toBe(baseline.fitness);

    const finalHashResumed = resumed.checkpoints[resumed.checkpoints.length - 1].hash;
    expect(finalHashResumed).toBe(finalHashBaseline);
  });

  it('(3) CallCache returns a hit and does not call compute again', () => {
    const cache = new CallCache();
    const key = { genomeId: GENOME, step: 0, input: null };
    let calls = 0;
    const first = cache.getOrCompute(key, () => {
      calls += 1;
      return 42;
    });
    const second = cache.getOrCompute(key, () => {
      calls += 1;
      return -1;
    });
    expect(first).toEqual({ value: 42, hit: false });
    expect(second).toEqual({ value: 42, hit: true });
    expect(calls).toBe(1);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  it('(4) store serialize/deserialize round-trips', () => {
    const store = new CheckpointStore();
    runWithCheckpoints({
      runId: RUN_ID,
      genomeId: GENOME,
      steps: makeSteps(4),
      policy: defaultPolicy(),
      store,
    });
    const restored = CheckpointStore.deserialize(store.serialize());
    expect(restored.load(RUN_ID)).toEqual(store.load(RUN_ID));
    expect(restored.latest(RUN_ID)).toEqual(store.latest(RUN_ID));
  });
});
