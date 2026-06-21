import type { CodeGenerator } from './mutator.js';
import type { MutationSurface } from './types.js';
export interface RuvllmMutatorOptions {
    /** Base URL of the `ruvllm serve` endpoint. Default: http://localhost:8080 (or RUVLLM_URL). */
    baseUrl?: string;
    /** Model name passed in the request body. Default: 'local' (or RUVLLM_MODEL). */
    model?: string;
    maxTokens?: number;
    temperature?: number;
    /** Request timeout in ms. Default: 30_000. */
    timeoutMs?: number;
}
export declare class RuvllmMutator implements CodeGenerator {
    private readonly baseUrl;
    private readonly model;
    private readonly maxTokens;
    private readonly temperature;
    private readonly timeoutMs;
    constructor(opts?: RuvllmMutatorOptions);
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
}
//# sourceMappingURL=ruvllm-mutator.d.ts.map