/** One transcript entry: the raw serialized action + the observation it produced. */
export interface TranscriptEntry {
    actionRaw?: unknown;
    obs?: unknown;
}
/** An action recovered from actionRaw (possibly via regex fallback on truncated JSON). */
export interface ParsedAction {
    tool?: string;
    path?: string;
    _truncated?: boolean;
    _unparseable?: boolean;
    [key: string]: unknown;
}
/** Extract the action object from a transcript entry's actionRaw (JSON.stringify(action).slice(0,400)
 * — possibly TRUNCATED, so fall back to regex extraction of tool/path when JSON.parse fails). */
export declare function parseActionRaw(actionRaw: unknown): ParsedAction;
/** Mechanical facts extracted from one executor transcript. */
export interface TranscriptAnalysis {
    steps: number;
    counts: Record<string, number>;
    runTestsCount: number;
    runTestsFails: number;
    runTestsPasses: number;
    editAttempts: number;
    editsLanded: number;
    editsFailed: number;
    testFileEditAttempts: number;
    noopCount: number;
    filesRead: string[];
    filesEdited: string[];
    repeatedActionWarnings: number;
    submitted: boolean;
    vetoes: number;
    advisories: number;
}
/** Mechanical trajectory analysis over an advisorSolve/agenticSolve transcript ({actionRaw, obs}[]). */
export declare function analyzeTranscript(transcript?: TranscriptEntry[]): TranscriptAnalysis;
/** Facts about a unified diff: files touched, test/non-test split, ± line count. */
export interface PatchStats {
    files: string[];
    nonTestFiles: string[];
    testFiles: string[];
    changedLines: number;
    empty: boolean;
}
export type IsTestPath = (path: string) => boolean;
/** Non-test source files touched by a unified diff, + total changed (±) line count. */
export declare function patchStats(patch: unknown, isTestPath?: IsTestPath): PatchStats;
/** Files touched by the GOLD patch (scoring-side only — never enters any executor prompt). */
export declare function goldFiles(goldPatch: unknown): string[];
/** The itemized §5.1 score terms. */
export interface ScoreParts {
    goldResolved: number;
    targetedTestsPass: number;
    minimalPatch: number;
    touchedExpectedFiles: number;
    emptyPatch: number;
    repeatedReads: number;
    noTestsRun: number;
    testFileEdits: number;
    normalizedCost: number;
}
export interface InstanceScore {
    score: number;
    parts: ScoreParts;
    patch: PatchStats;
}
export interface ComputeInstanceScoreInput {
    goldResolved?: boolean;
    resolvedInLoop?: boolean;
    patch?: string;
    goldPatchFiles?: string[] | null;
    analysis?: TranscriptAnalysis;
    cost?: number;
    thrash?: number;
    costCap?: number;
    isTestPath?: IsTestPath;
}
/**
 * The pre-registered §5.1 score. Inputs are plain facts; returns { score, parts } with every
 * term itemized so the ASI can cite them. costCap defaults to $0.50 (clamped normalized cost).
 */
export declare function computeInstanceScore({ goldResolved, resolvedInLoop, patch, goldPatchFiles, analysis, cost, thrash, costCap, isTestPath, }?: ComputeInstanceScoreInput): InstanceScore;
/** ADR-228 §5.3 failure classes. 0 = resolved. Deterministic precedence, tested. */
export declare const FAILURE_CLASSES: Record<number, string>;
export interface ClassifyFailureInput {
    goldResolved?: boolean;
    analysis?: TranscriptAnalysis;
    patch?: string;
    goldPatchFiles?: string[] | null;
    maxSteps?: number;
}
export declare function classifyFailure({ goldResolved, analysis, patch, goldPatchFiles, maxSteps, }?: ClassifyFailureInput): number;
export interface MakeFeedbackInput {
    instanceId?: string;
    analysis?: TranscriptAnalysis;
    scored?: InstanceScore;
    failureClass?: number | null;
    goldPatchFiles?: string[] | null;
    teacherSummary?: string | null;
    error?: string | null;
}
/**
 * §5.2 — the per-instance ASI: rich prose the reflection LM can act on, generated mechanically
 * from the transcript analysis + score parts + the paired teacher summary where one exists.
 */
export declare function makeFeedback({ instanceId, analysis, scored, failureClass, goldPatchFiles, teacherSummary, error, }?: MakeFeedbackInput): string;
//# sourceMappingURL=metric.d.ts.map