import type { RepoProfile } from './types.js';
/**
 * planner.ts — turns a task string into an ordered list of plan steps. The
 * baseline plan is a generic map → inspect → patch → verify loop, with the
 * repository summary baked in as data for downstream context.
 */
export declare function plannerTemplate(profile: RepoProfile): string;
/**
 * context_builder.ts — ranks candidate files by lexical overlap with the task
 * terms and returns the top slice as context items.
 */
export declare function contextBuilderTemplate(): string;
/**
 * reviewer.ts — flags changed files that intersect an injected risk-file list
 * and escalates severity when tests have failed. No inline pattern matching on
 * sensitive words; the risk set is passed in as data.
 */
export declare function reviewerTemplate(): string;
/**
 * retry_policy.ts — decides whether to retry an attempt based on a symbolic
 * failure classification (an injected enum), never by scanning raw output.
 */
export declare function retryPolicyTemplate(): string;
/**
 * tool_policy.ts — expresses the tool policy over symbolic command kinds, with
 * an allow-list and a deterministic ordering. No raw shell strings appear.
 */
export declare function toolPolicyTemplate(): string;
/**
 * memory_policy.ts — decides whether an outcome record is worth remembering.
 */
export declare function memoryPolicyTemplate(): string;
/**
 * score_policy.ts — the weight vector folded over the positive scoring terms.
 */
export declare function scorePolicyTemplate(): string;
//# sourceMappingURL=templates.d.ts.map