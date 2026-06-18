// SPDX-License-Identifier: MIT
//
// Tests for the self-directed curriculum (ADR-097): admit tasks by difficulty,
// re-pin the sub-suite (still verifies), and escalate only on mastery.

import { describe, expect, it } from 'vitest';
import {
  admittedTasks,
  curriculumSuite,
  maxDifficulty,
  nextCurriculumLevel,
} from '../src/curriculum.js';
import { makeSuite, verifySuite } from '../src/bench/suite.js';
import type { BenchmarkTask } from '../src/bench/types.js';

function task(id: string, difficulty: 1 | 2 | 3 | 4 | 5): BenchmarkTask {
  const ok = 'node -e "process.exit(0)"';
  return {
    id, repo: 'r', commit: 'HEAD', title: id, prompt: 'p',
    publicTestCommand: ok, hiddenTestCommand: ok, regressionTestCommand: ok,
    timeoutMs: 1000, maxCostUsd: 1, allowedMutationFiles: [], blockedFiles: [],
    successCriteria: [], difficulty, tags: [],
  };
}
const suite = makeSuite('s', '1.0.0', [task('a', 1), task('b', 1), task('c', 3), task('d', 5)]);

describe('curriculum', () => {
  it('admits only tasks at or below the level', () => {
    expect(admittedTasks(suite.tasks, 1).map((t) => t.id)).toEqual(['a', 'b']);
    expect(admittedTasks(suite.tasks, 3).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(admittedTasks(suite.tasks, 5).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('curriculumSuite re-pins a valid (verifiable) sub-suite', () => {
    const sub = curriculumSuite(suite, 1);
    expect(sub.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(verifySuite(sub).ok).toBe(true); // selecting a tier is not tampering
  });

  it('never yields an empty suite (falls back to the lowest tier)', () => {
    const hard = makeSuite('h', '1', [task('x', 3), task('y', 4)]);
    expect(curriculumSuite(hard, 1).tasks.map((t) => t.id)).toEqual(['x']); // min difficulty 3
  });

  it('maxDifficulty is the top rung', () => {
    expect(maxDifficulty(suite)).toBe(5);
  });

  it('escalates only on mastery, capped at the top rung', () => {
    expect(nextCurriculumLevel(1, 0.95, 5, 0.9)).toBe(2); // mastered → +1
    expect(nextCurriculumLevel(1, 0.5, 5, 0.9)).toBe(1); // not mastered → hold
    expect(nextCurriculumLevel(5, 1.0, 5, 0.9)).toBe(5); // capped at top
  });
});
