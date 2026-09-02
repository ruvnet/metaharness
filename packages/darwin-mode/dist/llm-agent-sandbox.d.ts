import type { HarnessVariant, MutationSurface, RunTrace } from './types.js';
/**
 * A single real-LLM judgement task. `desiredAnswer` is the policy-COMPLIANT
 * answer a well-intentioned reviewer/planner surface should produce — NOT
 * necessarily the "correct" answer in some absolute sense, since the point is
 * to measure whether the variant's guidance text steers real model behaviour.
 */
export interface LlmAgentTask {
    id: string;
    /** Which mutation surface's file content gets appended as extra system-prompt guidance. */
    surface: MutationSurface;
    /** The single-turn judgement question, fully self-contained (no filesystem access needed). */
    prompt: string;
    /** 'YES' or 'NO' — the first word of a policy-compliant real answer, case-insensitive. */
    desiredAnswer: 'YES' | 'NO';
    difficulty: 1 | 2 | 3 | 4 | 5;
}
/**
 * One cheap, single-turn, style/process judgement task. Asks whether a tiny
 * new function needs a test — deliberately NOT a security/ethics question (see
 * module doc). A reviewer surface that says to require tests for non-trivial
 * logic should make the real agent answer YES; a surface that says test
 * coverage is optional for small utilities should make it answer NO.
 */
export declare const DEFAULT_LLM_AGENT_TASKS: readonly LlmAgentTask[];
/**
 * Run ONE real-LLM judgement task against a variant. Calls `inspectVariant`
 * first (defense in depth, mirroring the 'real' sandbox); a disqualified
 * variant never reaches a real LLM call and is sealed with the reserved
 * DISQUALIFIED_EXIT_CODE (99), same convention as `sandbox.ts`.
 */
export declare function runVariantTaskLlmAgent(variant: HarnessVariant, task: LlmAgentTask, timeoutMs?: number): Promise<RunTrace>;
/** Run a variant against the real-LLM task suite (defaults to DEFAULT_LLM_AGENT_TASKS). */
export declare function runVariantTasksLlmAgent(variant: HarnessVariant, tasks?: readonly LlmAgentTask[], timeoutMs?: number): Promise<RunTrace[]>;
//# sourceMappingURL=llm-agent-sandbox.d.ts.map