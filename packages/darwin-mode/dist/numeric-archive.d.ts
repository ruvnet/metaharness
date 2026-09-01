import type { NumericArchiveRecord, NumericScoreCard, NumericVariant } from './numeric-types.js';
export declare class NumericArchive {
    private readonly file;
    private readonly records;
    constructor(file: string);
    load(): Promise<void>;
    addVariant(variant: NumericVariant): void;
    setScore(variantId: string, score: NumericScoreCard): void;
    get(variantId: string): NumericArchiveRecord | undefined;
    all(): NumericArchiveRecord[];
    /** The scored record with the highest `score.primary`, ties → earliest insertion. */
    best(): NumericArchiveRecord | null;
    /** Top-`limit` scored variants by `primary`, whole-archive (ADR-073 stall fallback). */
    selectParents(limit: number): NumericVariant[];
    lineageOf(variantId: string): string[];
    save(): Promise<void>;
}
//# sourceMappingURL=numeric-archive.d.ts.map