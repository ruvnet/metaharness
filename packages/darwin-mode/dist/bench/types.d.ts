/** A single benchmark task: a repo state + a goal + the commands that judge it. */
export interface BenchmarkTask {
    id: string;
    repo: string;
    /** The commit the task is pinned to (part of the immutable snapshot). */
    commit: string;
    title: string;
    prompt: string;
    /** Visible acceptance test. */
    publicTestCommand: string;
    /** Held-out test, mounted only at eval time (anti-overfitting). */
    hiddenTestCommand: string;
    /** Full relevant suite, to catch regressions. */
    regressionTestCommand: string;
    timeoutMs: number;
    maxCostUsd: number;
    /** Files a variant is permitted to change for this task. */
    allowedMutationFiles: string[];
    /** Files that must never be touched (secrets, lockfiles, CI). */
    blockedFiles: string[];
    successCriteria: string[];
    difficulty: 1 | 2 | 3 | 4 | 5;
    tags: string[];
}
/**
 * A versioned, hash-pinned task set. The `taskHash` is the anti-gaming anchor:
 * replay refuses to run if the tasks have changed (immutable task snapshots).
 */
export interface BenchSuite {
    id: string;
    version: string;
    createdAt: string;
    /** Stable hash over the canonicalised tasks (see suite.ts `hashTasks`). */
    taskHash: string;
    tasks: BenchmarkTask[];
}
/** The outcome of running ONE variant against ONE task. */
export interface BenchmarkResult {
    taskId: string;
    variantId: string;
    parentId: string | null;
    repoCommit: string;
    /** verified_solve: public ∧ hidden ∧ regression ∧ safety all passed. */
    solved: boolean;
    publicTestPassed: boolean;
    hiddenTestPassed: boolean;
    regressionPassed: boolean;
    durationMs: number;
    costUsd: number;
    changedFiles: string[];
    /** Any blocked file the variant tried to change (a hard safety penalty). */
    blockedFileTouches: string[];
    /** Safety findings (e.g. from the ADR-071 gate). Non-empty ⇒ unsafe. */
    safetyViolations: string[];
    /** A referenced file that does not exist (hallucination penalty). */
    hallucinatedFileRefs: boolean;
    traceQuality: number;
    /** Relative path to the persisted patch + trace (for replay/audit). */
    patchPath: string;
    tracePath: string;
    /** Weighted base score before penalties (0..1). */
    baseScore: number;
    /** baseScore minus the penalty layer (may be negative). */
    finalScore: number;
}
/** The pure inputs the benchmark scorer needs (decoupled from I/O). */
export interface BenchScoreInput {
    publicTestPassed: boolean;
    hiddenTestPassed: boolean;
    regressionPassed: boolean;
    safetyViolations: string[];
    blockedFileTouches: string[];
    hallucinatedFileRefs: boolean;
    costUsd: number;
    maxCostUsd: number;
    durationMs: number;
    timeoutMs: number;
}
/** The pure output of the benchmark scorer. */
export interface BenchScore {
    verifiedSolve: boolean;
    publicTestPass: number;
    hiddenTestPass: number;
    regressionPass: number;
    costEfficiency: number;
    latencyEfficiency: number;
    safetyViolation: number;
    blockedFileTouch: number;
    regressionFailure: number;
    hallucinatedFileReference: number;
    excessiveCost: number;
    baseScore: number;
    finalScore: number;
}
/** One of the five evaluation gates. */
export type GateName = 'solve' | 'regression' | 'safety' | 'cost' | 'repro';
export interface GateResult {
    gate: GateName;
    pass: boolean;
    detail: string;
}
/** Result of a seeded bootstrap over the parent→child per-task score deltas. */
export interface BootstrapResult {
    meanDelta: number;
    lower95: number;
    upper95: number;
    /** meanDelta > minDelta ∧ lower95 > 0. */
    promote: boolean;
    samples: number;
    /** One-sided bootstrap p-value for H0: delta ≤ 0 (fraction of resamples ≤ 0). */
    pValue: number;
}
/** The full, auditable promotion verdict for a child vs its parent. */
export interface PromotionDecision {
    promote: boolean;
    reasons: string[];
    meanDelta: number;
    lower95: number;
    childMeanScore: number;
    parentMeanScore: number;
    childVerifiedSolveRate: number;
    parentVerifiedSolveRate: number;
    childRegressionRate: number;
    parentRegressionRate: number;
    childSafetyViolations: number;
    cleanReplay: boolean;
    /** One-sided bootstrap p-value for the child>parent win (for FDR control, ADR-096). */
    pValue: number;
}
/** A node in the lineage tree used for descendant-potential analysis. */
export interface LineageNode {
    id: string;
    parentId: string | null;
    score: number;
    children: string[];
}
/** Runs one variant against one task, producing a BenchmarkResult. */
export type RunVariantFn = (variantId: string, task: BenchmarkTask) => Promise<BenchmarkResult>;
//# sourceMappingURL=types.d.ts.map