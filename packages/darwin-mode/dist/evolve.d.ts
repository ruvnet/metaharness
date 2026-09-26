import type { ArchiveRecord, EvolutionConfig, EvolutionResult, HarnessVariant, RepoProfile, RunTrace, ScoreCard } from './types.js';
/** Run async `fn` over `items` with at most `limit` in flight at once. Order-preserving. */
export declare function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
interface Evaluation {
    variant: HarnessVariant;
    traces: RunTrace[];
    score: ScoreCard;
}
/**
 * Run + score one variant. Pure of archive mutation (caller commits results).
 * Exported for direct testing of the ADR-249 cost-seam wiring below.
 */
export declare function evaluateVariant(variant: HarnessVariant, profile: RepoProfile, cfg: EvolutionConfig, parentScore: ScoreCard | null): Promise<Evaluation>;
/**
 * Fraction of `traces` whose combined stdout+stderr is non-empty — the
 * deterministic ADR-249 traceQuality seam's signal, finally wired to a real
 * call site. A variant whose runs produce no output at all scores lower than
 * one that produces normal output (a crash that prints a stack trace still
 * counts as output). Unlike `variantBytes` (which reads a variant's on-disk surface), this reads
 * already-collected trace data, so it costs nothing extra to compute.
 */
export declare function substantiveTraceRatio(traces: RunTrace[]): number;
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
export {};
//# sourceMappingURL=evolve.d.ts.map