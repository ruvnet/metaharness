import type { ArchiveRecord, EvolutionConfig, EvolutionResult, RunTrace } from './types.js';
/** Run async `fn` over `items` with at most `limit` in flight at once. Order-preserving. */
export declare function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
/**
 * Among scored records sharing the TOP finalScore, return the most efficient
 * (lowest mean trace wall-clock). Pure: caller supplies the per-variant traces.
 * Returns `null` only when no record is scored. This is the 'faster' tie-break
 * (ADR-072 scorer is ceiling-bound, so the efficiency signal lives here, not in
 * finalScore). NOT reproducible by construction — opt-in via config.tieBreaker.
 */
export declare function pickEfficientWinner(records: ArchiveRecord[], tracesById: Map<string, RunTrace[]>): ArchiveRecord | null;
/**
 * Run a full Darwin Mode evolution. Returns the baseline, the winning record,
 * the whole archive, and the winner's lineage. Side effects are confined to the
 * `<workRoot>/.metaharness`-style tree (variants, runs, reports, archive.json,
 * lineage.json).
 */
export declare function evolve(config: EvolutionConfig): Promise<EvolutionResult>;
//# sourceMappingURL=evolve.d.ts.map