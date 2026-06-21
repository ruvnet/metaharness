import type { HarnessVariant, RepoProfile } from '../types.js';
import type { BenchSuite, BenchmarkResult, BenchmarkTask, PromotionDecision, RunVariantFn } from './types.js';
export interface RunnerOptions {
    /** Cost-proxy in USD charged per task (metered, never self-reported). Default 0. */
    costUsdPerTask?: number;
}
/**
 * Run ONE variant against ONE task in the sandbox and score it. The three test
 * commands run with the variant's directory gate-checked first; any blocked
 * action surfaces as a safety violation (and the command never runs).
 */
export declare function runTaskForVariant(variant: HarnessVariant, profile: RepoProfile, task: BenchmarkTask, opts?: RunnerOptions): Promise<BenchmarkResult>;
/**
 * Evaluate a child against its parent over a task set using an INJECTED runner
 * (the user-facing, testable shape). Carries FULL result objects — so the safety
 * check is over real `safetyViolations`/`blockedFileTouches`, not a score proxy —
 * and returns the statistical promotion decision (ADR-076).
 */
export declare function evaluateWithRunner(input: {
    parentId: string;
    childId: string;
    tasks: BenchmarkTask[];
    runVariant: RunVariantFn;
    cleanReplay?: boolean;
    seed?: number;
    samples?: number;
    minDelta?: number;
}): Promise<{
    parentResults: BenchmarkResult[];
    childResults: BenchmarkResult[];
    decision: PromotionDecision;
}>;
/**
 * Evaluate a child harness against its parent over a hash-verified suite, using
 * the real secure sandbox. Verifies the suite snapshot first (benchmark-tampering
 * control), then delegates to `evaluateWithRunner`.
 */
export declare function evaluateChildAgainstParent(input: {
    parent: HarnessVariant;
    child: HarnessVariant;
    profile: RepoProfile;
    suite: BenchSuite;
    cleanReplay?: boolean;
    seed?: number;
    samples?: number;
    minDelta?: number;
    opts?: RunnerOptions;
}): Promise<{
    parentResults: BenchmarkResult[];
    childResults: BenchmarkResult[];
    decision: PromotionDecision;
}>;
//# sourceMappingURL=runner.d.ts.map