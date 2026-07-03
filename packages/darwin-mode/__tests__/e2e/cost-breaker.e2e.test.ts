// SPDX-License-Identifier: MIT
//
// ADR-072 cost circuit-breaker, end-to-end. With a tiny `costBudgetSeconds`,
// the per-generation evaluation loop stops committing further variants once the
// cumulative variant-seconds proxy crosses the budget — but the run must NOT
// crash: it still completes, writes reports/winner.json, and returns a winner.
//
// The breaker bounds work; it does not abort the loop. The baseline is always
// evaluated and committed before the breaker can fire, so a winner always exists.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { evolve } from '../../src/evolve.js';
import { inspectVariant } from '../../src/safety.js';
import type { EvolutionConfig, EvolutionResult } from '../../src/types.js';
import { makeFixture, type Fixture } from './fixtures/repo.js';

const BASE: Omit<EvolutionConfig, 'repoRoot' | 'workRoot' | 'costBudgetSeconds'> = {
  generations: 2,
  childrenPerGeneration: 3,
  concurrency: 3,
  seed: 0,
  promotionDelta: 0.05,
  tasks: ['t1', 't2'],
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

describe('evolve — cost circuit-breaker (ADR-072)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture('darwin-cost');
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('completes and writes a winner under a tiny per-generation budget', async () => {
    const result: EvolutionResult = await evolve({
      ...BASE,
      repoRoot: fx.repoRoot,
      workRoot: fx.workRoot,
      // Effectively zero budget: the breaker fires after the first committed
      // child each generation. The loop must still finish cleanly.
      costBudgetSeconds: 0.0001,
    });

    // The run completed: a winner exists and the report was written.
    expect(result.winner).not.toBeNull();
    expect(await isFile(join(fx.workRoot, 'reports', 'winner.json'))).toBe(true);
    expect(await isFile(join(fx.workRoot, 'archive.json'))).toBe(true);

    // The baseline was evaluated and is always a candidate winner.
    expect(result.baseline.score).not.toBeNull();

    // The breaker bounds work but never makes it unsafe.
    for (const record of result.records) {
      if (record.score === null) continue; // breaker may leave some uncommitted
      expect(record.score.safetyScore).toBe(1.0);
    }

    // Every variant directory that was created is still safe.
    for (const record of result.records) {
      expect(await inspectVariant(record.variant.dir)).toEqual([]);
    }
  }, 30_000); // one full evolve run — 5s default flakes on slow CI runners (macos matrix)

  it('a generous budget produces at least as many scored records as a tiny one', async () => {
    const tiny = await evolve({
      ...BASE,
      repoRoot: fx.repoRoot,
      workRoot: fx.workRoot,
      generations: 1,
      costBudgetSeconds: 0.0001,
    });
    const tinyScored = tiny.records.filter((r) => r.score !== null).length;

    // Fresh work tree for the generous run against the same repo.
    const fx2 = await makeFixture('darwin-cost-generous');
    try {
      const generous = await evolve({
        ...BASE,
        repoRoot: fx2.repoRoot,
        workRoot: fx2.workRoot,
        generations: 1,
        costBudgetSeconds: 10_000,
      });
      const generousScored = generous.records.filter((r) => r.score !== null).length;

      expect(generousScored).toBeGreaterThanOrEqual(tinyScored);
      // The generous run scores the baseline + all gen-1 children (1 + 3).
      expect(generousScored).toBe(4);
    } finally {
      await fx2.cleanup();
    }
  }, 30_000); // two full evolve runs back-to-back
});
