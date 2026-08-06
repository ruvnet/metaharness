import type { CodeGenerator } from './mutator.js';
import type { MutationSurface } from './types.js';
export interface RefineMutatorOptions {
    /** Base URL of an OpenAI-compatible endpoint (`POST /v1/chat/completions`).
     *  UNSET ⇒ the deterministic offline fallback (no network at all). */
    endpoint?: string;
    /** Model name passed in the request body. Default: 'local'. */
    model?: string;
    /** Request timeout in ms. Default: 30_000. */
    timeoutMs?: number;
}
/**
 * Parse citable evidence IDs from failed-trace lines. A line's ID is its
 * leading token up to ':' when that token matches /^[\w.-]+$/ (e.g.
 * 'trace-42: null deref' → 'trace-42'); any other non-blank line is citable as
 * 'trace-<lineIndex>'. Blank lines carry no evidence.
 */
export declare function parseEvidenceIds(failedTraces: string[]): string[];
export declare class RefineMutator implements CodeGenerator {
    private readonly endpoint;
    private readonly model;
    private readonly timeoutMs;
    constructor(opts?: RefineMutatorOptions);
    generateMutation(input: {
        parentCode: string;
        surface: MutationSurface;
        repoSummary: string;
        parentScore: number;
        failedTraces: string[];
        nonce?: number;
    }): Promise<{
        code: string;
        summary: string;
    }>;
    /** POST the refine prompt to the OpenAI-compatible endpoint. Any transport,
     *  timeout, or shape failure ⇒ a safe no-op (mirrors RuvllmMutator). */
    private propose;
}
//# sourceMappingURL=refine-mutator.d.ts.map