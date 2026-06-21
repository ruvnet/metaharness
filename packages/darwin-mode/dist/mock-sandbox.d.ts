import type { HarnessVariant, RunTrace } from './types.js';
/** Behaviour-shaping parameters read from a variant's surface files. */
export interface SurfaceParams {
    /** retryPolicy: attempt budget. */
    maxAttempts: number;
    /** contextBuilder: how many context items the agent "sees" per attempt. */
    contextWindow: number;
    /** memoryPolicy: keep-threshold (drives memory-accept events). */
    memoryThreshold: number;
    /** planner: number of plan steps (directive phrases) → loop length. */
    planSteps: number;
}
/** A scripted task. Solvable iff the agent retries enough AND sees enough context. */
export interface MockTask {
    id: string;
    /** Attempts that fail before the bug is fixable (needs maxAttempts > this). */
    failAttempts: number;
    /** Minimum context window to even observe the bug (needs contextWindow ≥ this). */
    requiredContext: number;
    /** Per-attempt backoff cost (ms) — makes durationMs a function of retries. */
    backoffMs: number;
    /** ADR-097 difficulty tier. */
    difficulty: 1 | 2 | 3 | 4 | 5;
}
/**
 * A graduated scripted ladder (drives the curriculum, ADR-097). Each rung needs
 * slightly more retry budget and/or context than the last, so an incremental
 * surface improvement solves incrementally MORE rungs — a climbable gradient
 * (not a deceptive all-or-nothing plateau). The lower rungs reward retry-budget
 * growth alone; the upper rungs additionally require a wider context window, so
 * the full ladder rewards combining both surfaces (crossover/epistasis).
 */
export declare const DEFAULT_MOCK_TASKS: readonly MockTask[];
/**
 * Extract surface parameters from a variant directory (text-parsing, not import).
 * Uses the same patterns the DeterministicMutator perturbs, so a mutation that
 * bumps a budget or a slice width is reflected here. Missing files → defaults.
 */
export declare function extractSurfaceParams(variantDir: string): Promise<SurfaceParams>;
export interface SimResult {
    solved: boolean;
    attemptsUsed: number;
    durationMs: number;
    log: string;
}
/**
 * Simulate a scripted agent loop. Outcome is a deterministic function of the
 * surface params and the task: the agent must (a) see enough context and
 * (b) retry past the task's failing attempts. The log records plan steps,
 * context builds, and retry decisions — so verbosity/repetition/duration all
 * vary by surface, populating the behavioural phenotype (ADR-091).
 */
export declare function simulateAgentLoop(params: SurfaceParams, task: MockTask): SimResult;
/** Run ONE mock task against a variant, producing a surface-dependent RunTrace. */
export declare function runVariantTaskMock(variant: HarnessVariant, task: MockTask, params?: SurfaceParams): Promise<RunTrace>;
/** Run a variant against a graded mock suite (defaults to DEFAULT_MOCK_TASKS). */
export declare function runVariantTasksMock(variant: HarnessVariant, tasks?: readonly MockTask[]): Promise<RunTrace[]>;
//# sourceMappingURL=mock-sandbox.d.ts.map