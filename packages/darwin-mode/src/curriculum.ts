// SPDX-License-Identifier: MIT
//
// Self-directed curriculum (ADR-097) — a difficulty LADDER over the benchmark.
// The honest fix for the "degenerate manifold" (Gap 3, benchmark saturation):
// scoring every variant on the full suite from generation 0 means an easy suite
// never forces struggle, so the high-complexity Poincaré frontier (ADR-091/092)
// stays empty. Instead, sequence the EXISTING graded tasks by their `difficulty`
// (1..5): admit only difficulty ≤ L, and raise L once the population MASTERS the
// current tier. Harder tasks arrive exactly when the agents are ready for them —
// "the perfect exam for the current population".
//
// This reuses real task metadata (no LLM task synthesis, no fabrication); it is
// pure and deterministic. An LLM-backed adversarial-task generator can extend it
// later behind the same admit() seam, but the deterministic ladder works today.

import { makeSuite } from './bench/suite.js';
import type { BenchSuite, BenchmarkTask } from './bench/types.js';

/** Tasks at or below the current difficulty level (the admitted curriculum tier). */
export function admittedTasks(tasks: readonly BenchmarkTask[], level: number): BenchmarkTask[] {
  return tasks.filter((t) => t.difficulty <= level);
}

/**
 * A hash-pinned sub-suite of just the admitted tasks. Re-pinned via `makeSuite`
 * so it still passes `verifySuite` (selecting a tier is not tampering). Falls
 * back to the lowest-difficulty tasks if `level` admits none (so a generation is
 * never scored on an empty suite).
 */
export function curriculumSuite(suite: BenchSuite, level: number): BenchSuite {
  let tasks = admittedTasks(suite.tasks, level);
  if (tasks.length === 0 && suite.tasks.length > 0) {
    const min = Math.min(...suite.tasks.map((t) => t.difficulty));
    tasks = suite.tasks.filter((t) => t.difficulty === min);
  }
  return makeSuite(suite.id, suite.version, tasks);
}

/** The highest difficulty present in the suite — the curriculum's top rung. */
export function maxDifficulty(suite: BenchSuite): number {
  return suite.tasks.reduce((m, t) => Math.max(m, t.difficulty), 1);
}

/**
 * Escalate the curriculum: if the population has MASTERED the current tier
 * (mean solve rate ≥ `threshold`), advance one level (capped at the suite's top
 * rung); otherwise hold. Pure. Default threshold 0.9.
 */
export function nextCurriculumLevel(
  level: number,
  meanSolveRate: number,
  cap: number,
  threshold = 0.9,
): number {
  if (meanSolveRate >= threshold && level < cap) return level + 1;
  return level;
}
