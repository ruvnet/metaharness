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
/** Run ONE agent task against a variant by executing its real surface code. */
export declare function runVariantTaskAgent(variant: HarnessVariant, task: AgentTask, timeoutMs?: number): Promise<RunTrace>;
/** Run a variant against the agent suite (defaults to DEFAULT_AGENT_TASKS). */
export declare function runVariantTasksAgent(variant: HarnessVariant, tasks?: readonly AgentTask[], timeoutMs?: number): Promise<RunTrace[]>;
//# sourceMappingURL=tier2-sandbox.d.ts.map