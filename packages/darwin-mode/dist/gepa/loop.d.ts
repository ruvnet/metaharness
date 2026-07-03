import { type Genome } from './genome.js';
/** A candidate's per-instance score vector (instanceId → score). */
export type ScoreVector = Record<string, number>;
/** Per-instance ASI feedback texts (instanceId → prose). */
export type FeedbackMap = Record<string, string>;
/** What the injected evaluator returns for one genome over the evaluation slice. */
export interface GepaEvalResult {
    scores: ScoreVector;
    feedbacks?: FeedbackMap;
    /** Dollar cost of the evaluation (0 for offline/stub evaluators). */
    cost?: number;
    /** Metric calls consumed (defaults to the number of scored instances — contract 4). */
    metricCalls?: number;
}
/** The injected evaluator: run one genome over the slice, return scores + ASI. */
export type GepaEvaluator = (genome: Genome) => Promise<GepaEvalResult>;
/** The injected reflection LM call: prompt in, raw proposal text (+ cost) out. */
export type GepaReflector = (prompt: string) => Promise<{
    raw: string;
    cost?: number;
}>;
/** A pool entry: a candidate genome + its evaluation results + lineage. */
export interface GepaCandidate {
    id: string;
    genome: Genome;
    scores: ScoreVector;
    feedbacks: FeedbackMap;
    accepted?: boolean;
    parent?: string | null;
}
export interface ParetoResult {
    /** Candidates that are (tied-)best on ≥1 instance. */
    frontier: string[];
    /** instanceId → ids tied-best on that instance. */
    winners: Record<string, string[]>;
    /** id → number of instances won. */
    wins: Record<string, number>;
    /** Highest MEAN score (mean drives tracking, per verified contract 2). */
    best: string | null;
    bestMean: number;
}
/**
 * GEPA Pareto frontier over per-instance score vectors.
 *   candidates: [{ id, scores: { instId: number } }]
 */
export declare function paretoFrontier(candidates: Array<Pick<GepaCandidate, 'id' | 'scores'>>): ParetoResult;
/** Sample the next parent from the frontier, frequency-weighted by instances won (GEPA §parent sampling). */
export declare function sampleParent(candidates: Array<Pick<GepaCandidate, 'id' | 'scores'>>, rng?: () => number): string | null;
/** Count 'mutation target:' votes in ASI feedback texts → { componentName: votes } (only names the genome knows). */
export declare function mutationTargetVotes(feedbacks: FeedbackMap | undefined, componentNames: string[]): Record<string, number>;
/** Pick the component to mutate: ASI-vote-ranked, falling back to round-robin over `mutable`. */
export declare function pickTargetComponent({ feedbacks, mutable, step, lastMutated }: {
    feedbacks?: FeedbackMap;
    mutable: string[];
    step?: number;
    lastMutated?: string | null;
}): string;
/** Build the reflection prompt: current component text + the worst instances' ASI → propose new text. */
export declare function buildReflectionPrompt({ genome, targetComponent, feedbacks, maxFeedbacks }: {
    genome: Genome;
    targetComponent: string;
    feedbacks?: FeedbackMap;
    maxFeedbacks?: number;
}): string;
/** Extract the proposed component text from the reflection LM's reply. null = unusable proposal. */
export declare function parseReflection(raw: unknown): string | null;
export interface GepaHistoryEvent {
    event: string;
    step?: number;
    id?: string;
    target?: string;
    parent?: string | null;
    reason?: string;
    error?: string;
    after?: number;
    sumChild?: number;
    sumParent?: number;
}
export interface GepaBudget {
    metricCalls: number;
    evalCost: number;
    reflectionCost: number;
    totalCost: number;
}
export interface GepaOptimizeResult {
    /** Evaluated candidates kept in the pool (feedbacks stripped — they can be large). */
    pool: Array<Omit<GepaCandidate, 'feedbacks'>>;
    frontier: string[];
    winners: Record<string, string[]>;
    best: string | null;
    bestMean: number;
    budget: GepaBudget;
    history: GepaHistoryEvent[];
}
export interface GepaOptimizeOptions {
    /** Seed genome object (dict[str,str] components). */
    seed: Genome;
    /** Injected evaluator: async (genome) => { scores, feedbacks, cost, metricCalls }. */
    evaluate: GepaEvaluator;
    /** Injected reflection LM: async (prompt) => { raw, cost }. */
    reflect: GepaReflector;
    rng?: () => number;
    /** Component names GEPA may touch (ADR-228 §6 optimize-first order). */
    mutable?: string[];
    maxCandidates?: number;
    maxMetricCalls?: number;
    maxCost?: number;
    maxStall?: number;
    onEvent?: (event: string, data: Record<string, unknown>) => void;
}
/**
 * The budgeted GEPA loop.
 * Stops when maxCandidates genomes have been EVALUATED (seed included — discarded candidates still
 * consume evaluations, which is what costs money), maxMetricCalls spent, maxCost ($) hit, or the
 * loop stalls (maxStall consecutive iterations without a successful evaluation).
 * Returns { pool, frontier, best, budget, history } — the FULL frontier is reported, not one winner
 * (ADR-228 §8 mitigation: keep Pareto candidates).
 */
export declare function gepaOptimize({ seed, evaluate, reflect, rng, mutable, maxCandidates, maxMetricCalls, maxCost, maxStall, onEvent, }: GepaOptimizeOptions): Promise<GepaOptimizeResult>;
//# sourceMappingURL=loop.d.ts.map