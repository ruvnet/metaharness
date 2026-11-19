import type { HarnessVariant, RunTrace } from './types.js';
/** A Tier-2 agent task: locate `buggyFile` among `files` and persist past `failAttempts`. */
export interface AgentTask {
    id: string;
    prompt: string;
    files: string[];
    buggyFile: string;
    classification: 'transient' | 'repairable' | 'unknown';
    failAttempts: number;
    backoffMs: number;
    difficulty: 1 | 2 | 3 | 4 | 5;
}
export declare const DEFAULT_AGENT_TASKS: readonly AgentTask[];
interface DriverOut {
    solved: boolean;
    attemptsUsed: number;
    durationMs: number;
    log: string;
    refused?: boolean;
    reason?: string;
}
/** Default heap cap (MiB) for the isolated Tier-2 child. */
export declare const TIER2_MAX_OLD_SPACE_MB = 256;
/**
 * The permission-model flag this runtime supports, or a reason it cannot
 * isolate Tier-2 execution. Exported for tests and diagnostics.
 */
export declare function tier2IsolationSupport(flags?: ReadonlySet<string>): {
    ok: true;
    permissionFlag: string;
} | {
    ok: false;
    reason: string;
};
/** Result of one isolated driver run. */
export type IsolatedDriverResult = {
    kind: 'ok';
    out: DriverOut;
} | {
    kind: 'refused';
    reason: string;
} | {
    kind: 'error';
    reason: string;
};
/**
 * Spawn the Tier-2 driver for `variantDir` in the isolated child process. This
 * does NOT run the static gate — callers must (`runVariantTaskAgent` does). It
 * is exported so the isolation layer can be tested on its own.
 */
export declare function spawnIsolatedDriver(variantDir: string, task: Omit<AgentTask, 'id' | 'difficulty'> & Partial<Pick<AgentTask, 'id' | 'difficulty'>>, opts?: {
    timeoutMs?: number;
    maxOldSpaceMb?: number;
    env?: NodeJS.ProcessEnv;
    /** Override the runtime's flag set (tests / diagnostics). */
    nodeFlags?: ReadonlySet<string>;
}): Promise<IsolatedDriverResult>;
/**
 * Run ONE agent task against a variant by executing its real surface code.
 *
 * The ADR-071 safety gate runs first: if `inspectVariant` reports any
 * findings, `tier2-driver.js` never imports/executes the variant's surface
 * files, and a disqualified trace (exitCode 99, mirroring `sandbox.ts` and
 * `llm-agent-sandbox.ts`) is returned instead.
 */
export declare function runVariantTaskAgent(variant: HarnessVariant, task: AgentTask, timeoutMs?: number): Promise<RunTrace>;
/** Run a variant against the agent suite (defaults to DEFAULT_AGENT_TASKS). */
export declare function runVariantTasksAgent(variant: HarnessVariant, tasks?: readonly AgentTask[], timeoutMs?: number): Promise<RunTrace[]>;
export {};
//# sourceMappingURL=tier2-sandbox.d.ts.map