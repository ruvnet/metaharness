// SPDX-License-Identifier: MIT
//
// End-to-end: the opt-in graded-promotion path (ADR-076/086). When `evolve` is
// given a hash-pinned benchmark suite, each child is evaluated against its
// parent over the suite in the real sandbox and the STATISTICAL decision drives
// promotion — a `runs/<id>.bench.json` is written and the score's `promoted`
// flag reflects `decision.promote`. The frozen scorer is untouched; this path
// is purely additive and opt-in.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { evolve } from '../../src/evolve.js';
import { makeSuite } from '../../src/bench/suite.js';
import type { BenchmarkTask } from '../../src/bench/types.js';
import type { EvolutionResult } from '../../src/types.js';
import { makeFixture, type Fixture } from './fixtures/repo.js';

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A trivial, always-passing task — every test command exits 0 regardless of cwd. */
function passingTask(id: string): BenchmarkTask {
  const ok = 'node -e "process.exit(0)"';
  return {
    id,
    repo: 'fixture',
    commit: 'HEAD',
    title: `trivial ${id}`,
    prompt: 'no-op',
    publicTestCommand: ok,
    hiddenTestCommand: ok,
    regressionTestCommand: ok,
    timeoutMs: 30_000,
    maxCostUsd: 1,
    allowedMutationFiles: [],
    blockedFiles: [],
    successCriteria: ['exit 0'],
    difficulty: 1,
    tags: ['smoke'],
  };
}

describe('evolve — opt-in graded promotion (ADR-076 bench gate)', () => {
  let fx: Fixture;
  let result: EvolutionResult;

  beforeEach(async () => {
    fx = await makeFixture('darwin-evolve-bench');
    const suite = makeSuite('smoke-suite', '1.0.0', [passingTask('b1')]);
    result = await evolve({
      repoRoot: fx.repoRoot,
      workRoot: fx.workRoot,
      generations: 1,
      childrenPerGeneration: 2,
      concurrency: 2,
      seed: 0,
      promotionDelta: 0.05,
      tasks: ['t1'],
      benchSuite: suite,
    });
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('writes a PromotionDecision artifact per child and drives promotion from it', async () => {
    const children = result.records.filter((r) => r.variant.parentId !== null);
    expect(children.length).toBeGreaterThan(0);

    for (const child of children) {
      const benchPath = join(fx.workRoot, 'runs', `${child.variant.id}.bench.json`);
      expect(await isFile(benchPath)).toBe(true);

      const decision = JSON.parse(await readFile(benchPath, 'utf8'));
      // Shape of a real PromotionDecision (ADR-076).
      expect(typeof decision.promote).toBe('boolean');
      expect(Array.isArray(decision.reasons)).toBe(true);
      expect(typeof decision.meanDelta).toBe('number');
      expect(typeof decision.childVerifiedSolveRate).toBe('number');

      // The score's promoted flag is the graded decision, and the reason is tagged.
      expect(child.score!.promoted).toBe(decision.promote);
      expect(child.score!.reason).toContain('bench(ADR-076)');
    }
  });

  it('still produces a winner and a valid work tree under the bench gate', async () => {
    expect(result.winner).not.toBeNull();
    expect(await isFile(join(fx.workRoot, 'reports', 'winner.json'))).toBe(true);
  });
});

describe('evolve — SGM cumulative risk budget (ADR-079)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture('darwin-evolve-risk');
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  it('a zero risk budget refuses every promotion and tags the reason', async () => {
    const suite = makeSuite('smoke-suite', '1.0.0', [passingTask('b1')]);
    const result = await evolve({
      repoRoot: fx.repoRoot,
      workRoot: fx.workRoot,
      generations: 1,
      childrenPerGeneration: 2,
      concurrency: 2,
      seed: 0,
      promotionDelta: 0.05,
      tasks: ['t1'],
      benchSuite: suite,
      riskBudgetTotal: 0, // no risk may be spent → nothing promotes
    });

    const children = result.records.filter((r) => r.variant.parentId !== null);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.score!.promoted).toBe(false);
      const decision = JSON.parse(
        await readFile(join(fx.workRoot, 'runs', `${child.variant.id}.bench.json`), 'utf8'),
      );
      // The SGM reasons + remaining-budget annotation are recorded.
      expect(decision.reasons.some((r: string) => r.includes('risk budget remaining'))).toBe(true);
    }
  });
});
