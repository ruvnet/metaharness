import type { NumericEvaluator, NumericGenome, NumericScoreCard } from './numeric-types.js';
export interface ShellEvaluatorOptions {
    /** argv[0] and the rest, e.g. `['node', 'gate-cli.mjs']` — never passed through a shell. */
    readonly command: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
    /** Extra env vars layered over the inherited parent environment (see `evaluate` for why it is not scrubbed). */
    readonly env?: Readonly<Record<string, string>>;
}
/** Spawns `options.command` per candidate; genome in on stdin, `NumericScoreCard` out on stdout. */
export declare class ShellEvaluator implements NumericEvaluator {
    private readonly options;
    constructor(options: ShellEvaluatorOptions);
    evaluate(genome: NumericGenome, variantId: string): Promise<NumericScoreCard>;
}
//# sourceMappingURL=numeric-evaluator.d.ts.map