import type { CodeGenerator } from './mutator.js';
import type { MutationSurface } from './types.js';
import type { MutatorTelemetry } from './openrouter-mutator.js';
export interface RequestyMutatorOptions {
    model?: string;
    /** Per-call cost/latency cap. */
    maxTokens?: number;
    temperature?: number;
}
export declare class RequestyMutator implements CodeGenerator {
    readonly model: string;
    private readonly maxTokens;
    private readonly temperature;
    readonly telemetry: MutatorTelemetry;
    constructor(opts?: RequestyMutatorOptions);
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
//# sourceMappingURL=requesty-mutator.d.ts.map