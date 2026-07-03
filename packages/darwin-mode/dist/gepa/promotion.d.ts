/** One instance's evaluation facts inside an eval JSON's `.details`. */
export interface InstanceDetail {
    gold?: boolean;
    failureClass?: number;
    thrash?: number;
    cost?: number;
    [key: string]: unknown;
}
export type EvalDetails = Record<string, InstanceDetail>;
/** The eval-artifact shape summarizeEval consumes (a run's aggregate + per-instance details). */
export interface EvalArtifact {
    details?: EvalDetails;
    goldResolved?: number;
    n?: number;
    sumScore?: number | null;
    cost?: number;
    [key: string]: unknown;
}
/** The comparable summary the report + promotion rule consume. */
export interface EvalSummary {
    n: number;
    gold: number;
    sum: number | null;
    emptyPatchRate: number;
    thrash: number;
    cost: number;
    costPerResolved: number;
    resolvedIds: string[];
}
/** Empty-patch instance ⇔ failureClass===3 (exploration-loop / empty patch). */
export declare const isEmptyPatchDetail: (d: InstanceDetail | null | undefined) => boolean;
/** Set of instance_ids the run gold-resolved, from an eval JSON's `.details`. */
export declare function resolvedIdSet(details?: EvalDetails): Set<string>;
/** Empty-patch rate = (# class-3 instances) / N, over an eval JSON's `.details`. */
export declare function emptyPatchRate(details?: EvalDetails): number;
/** Sum of per-instance thrash from `.details`. */
export declare function totalThrash(details?: EvalDetails): number;
/** Roll a full eval JSON into the comparable summary the report + rule consume. */
export declare function summarizeEval(ev?: EvalArtifact): EvalSummary;
export interface PromotionChecks {
    goldNoRegress: boolean;
    emptyPatchImproves: boolean;
    costPerResolvedNotWorse: boolean;
}
export interface PromotionVerdict {
    promote: boolean;
    reason: string;
    checks: PromotionChecks;
    regressions: string[];
    gains: string[];
}
/**
 * The STRICT promotion predicate over HOLDOUT seed vs candidate summaries (from summarizeEval).
 * Returns { promote, reason, checks, regressions, gains }.
 */
export declare function evaluatePromotion({ seed, cand }: {
    seed: EvalSummary;
    cand: EvalSummary;
}): PromotionVerdict;
export interface CompositeKeyParts {
    host?: string;
    model?: string;
    vertical?: string;
    language?: string;
    task_class?: string;
    genome_version?: string;
}
/** Composite registry key: host+model+vertical+language+task_class+genome_version. */
export declare function compositeKey({ host, model, vertical, language, task_class, genome_version }: CompositeKeyParts): string;
export interface PromotionKeyMeta {
    vertical?: string;
    language?: string;
    task_class?: string;
}
export interface PromotionRunProvenance {
    best?: string | null;
    frontier?: string[];
    bestMean?: number;
    budget?: unknown;
    holdout?: {
        goldDelta?: number | null;
    } | null;
    [key: string]: unknown;
}
export interface PromotionReportInput {
    host: string;
    model: string;
    slice: string;
    seedId: string;
    candId: string;
    genomeVersion: string;
    train: {
        seed: EvalSummary;
        cand?: EvalSummary | null;
    };
    holdout: {
        seed: EvalSummary;
        cand?: EvalSummary | null;
    };
    keyMeta?: PromotionKeyMeta;
    run?: PromotionRunProvenance | null;
    ranAt?: string;
}
export interface PromotionReport {
    ranAt: string;
    key: string;
    keyParts: Required<CompositeKeyParts>;
    slice: string;
    seed: string;
    candidate: string;
    train: {
        seed: EvalSummary;
        cand: EvalSummary | null;
    };
    holdout: {
        seed: EvalSummary;
        cand: EvalSummary | null;
    };
    regressions: string[];
    gains: string[];
    checks: PromotionChecks;
    verdict: 'promote' | 'reject';
    reason: string;
    rule: string;
    run: {
        best?: string | null;
        frontier?: string[];
        bestMean?: number;
        budget?: unknown;
        holdoutGoldDelta: number | null | undefined;
    } | null;
}
/**
 * Assemble the full promotion report object (pure — a CLI just feeds it real evals + writes it).
 *   host, model, slice, seedId, candId, genomeVersion
 *   train  { seed, cand }  holdout { seed, cand }  — each a summarizeEval() result (cand optional)
 *   keyMeta { vertical, language, task_class }
 *   run    { budget, best, frontier, ... }  (optional provenance from the GEPA run)
 */
export declare function buildPromotionReport({ host, model, slice, seedId, candId, genomeVersion, train, holdout, keyMeta, run, ranAt, }: PromotionReportInput): PromotionReport;
//# sourceMappingURL=promotion.d.ts.map