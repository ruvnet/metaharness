import type { BenchSuite, BenchmarkTask } from './bench/types.js';
/** Tasks at or below the current difficulty level (the admitted curriculum tier). */
export declare function admittedTasks(tasks: readonly BenchmarkTask[], level: number): BenchmarkTask[];
/**
 * A hash-pinned sub-suite of just the admitted tasks. Re-pinned via `makeSuite`
 * so it still passes `verifySuite` (selecting a tier is not tampering). Falls
 * back to the lowest-difficulty tasks if `level` admits none (so a generation is
 * never scored on an empty suite).
 */
export declare function curriculumSuite(suite: BenchSuite, level: number): BenchSuite;
/** The highest difficulty present in the suite — the curriculum's top rung. */
export declare function maxDifficulty(suite: BenchSuite): number;
/**
 * Escalate the curriculum: if the population has MASTERED the current tier
 * (mean solve rate ≥ `threshold`), advance one level (capped at the suite's top
 * rung); otherwise hold. Pure. Default threshold 0.9.
 */
export declare function nextCurriculumLevel(level: number, meanSolveRate: number, cap: number, threshold?: number): number;
//# sourceMappingURL=curriculum.d.ts.map