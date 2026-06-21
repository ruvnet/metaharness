import type { CodeGenerator } from './mutator.js';
import type { MutationSurface } from './types.js';
export interface OpenRouterMutatorOptions {
    model?: string;
    /** Per-call cost/latency cap. */
    maxTokens?: number;
    temperature?: number;
}
export interface MutatorTelemetry {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    costUSD: number;
}
export declare class OpenRouterMutator implements CodeGenerator {
    readonly model: string;
    private readonly maxTokens;
    private readonly temperature;
    readonly telemetry: MutatorTelemetry;
    constructor(opts?: OpenRouterMutatorOptions);
    generateMutation(input: {
        parentCode: string;
        surface: MutationSurface;
        repoSummary: string;
        parentScore: number;
        failedTraces: string[];
    }): Promise<{
        code: string;
        summary: string;
    }>;
}
//# sourceMappingURL=openrouter-mutator.d.ts.map