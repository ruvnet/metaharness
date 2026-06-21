import type { HarnessVariant, RepoProfile, RunTrace } from './types.js';
/** Tunables for one sandboxed run. */
export interface SandboxOptions {
    /** Wall-clock budget for the test command (ms). Default 120000. */
    taskTimeoutMs?: number;
    /** Max bytes of combined stdout/stderr to buffer. Default 8 MiB. */
    maxBufferBytes?: number;
}
/**
 * Run one variant against one task in the sandbox.
 *
 * The ADR-071 safety gate runs first: if `inspectVariant` reports any findings,
 * no command is executed and a disqualified trace (exitCode 99) is returned.
 * Otherwise the profile's `testCommand` is executed via `execFile` (no shell)
 * with a scrubbed env. Never throws — failures become RunTraces.
 */
export declare function runVariantTask(variant: HarnessVariant, profile: RepoProfile, taskId: string, opts?: SandboxOptions): Promise<RunTrace>;
/**
 * Run a variant against a list of tasks sequentially, returning every trace.
 * Sequential by design: it bounds resource use and keeps traces deterministic
 * (the population-level concurrency budget lives in the evolution loop, not here).
 */
export declare function runVariantTasks(variant: HarnessVariant, profile: RepoProfile, taskIds: string[], opts?: SandboxOptions): Promise<RunTrace[]>;
//# sourceMappingURL=sandbox.d.ts.map