import type { Finding, HarnessGenome, PatchExample, RepoProfile, SecurityVectorMeta } from './types.js';
import type { CorpusSite } from './corpus.js';
/** A stored vector: its embedding plus typed metadata and payload. */
interface VectorEntry<T> {
    vector: number[];
    meta: SecurityVectorMeta;
    payload: T;
}
/** A typed collection of vectors (a thin in-memory ruVector stand-in). */
declare class VectorCollection<T> {
    private readonly entries;
    add(text: string, meta: SecurityVectorMeta, payload: T): void;
    size(): number;
    /** Top-k by cosine similarity to the query text. */
    search(queryText: string, k: number): Array<{
        score: number;
        meta: SecurityVectorMeta;
        payload: T;
    }>;
    /** Best cosine similarity of `queryText` to anything in the collection (0 if empty). */
    maxSimilarity(queryText: string): number;
    all(): ReadonlyArray<VectorEntry<T>>;
}
/** The weights of the hybrid ranking formula (ADR-155). Exposed for audit. */
export declare const HYBRID_WEIGHTS: {
    readonly vectorSimilarity: 0.45;
    readonly callgraphCentrality: 0.2;
    readonly taintSinkProximity: 0.15;
    readonly historicalFindingSimilarity: 0.1;
    readonly recentChangeWeight: 0.1;
    readonly falsePositiveSimilarity: -0.25;
};
/** Inputs to the hybrid ranker for a single candidate site. */
export interface RankInputs {
    vectorSimilarity: number;
    callgraphCentrality: number;
    taintSinkProximity: number;
    historicalFindingSimilarity: number;
    recentChangeWeight: number;
    falsePositiveSimilarity: number;
}
/** The pure hybrid-ranking score for one candidate (can be negative). */
export declare function hybridRank(x: RankInputs): number;
/** The learning security memory (ADR-155 §key API `RuvSecurityMemory`). */
export declare class RuvSecurityMemory {
    readonly codeChunks: VectorCollection<CorpusSite>;
    readonly callgraphNodes: VectorCollection<{
        siteId: string;
    }>;
    readonly confirmedFindings: VectorCollection<Finding>;
    readonly falsePositives: VectorCollection<Finding>;
    readonly patches: VectorCollection<PatchExample>;
    readonly genomes: VectorCollection<HarnessGenome>;
    readonly receipts: VectorCollection<{
        taskId: string;
    }>;
    /** Index a repo's code sites so future runs can retrieve similar code. */
    indexSites(repo: string, commit: string, sites: CorpusSite[]): {
        indexed: number;
    };
    /** Record a confirmed finding + its patch into long-term memory. */
    writeConfirmed(finding: Finding): void;
    /** Record a rejected hypothesis (negative memory). */
    writeFalsePositive(finding: Finding): void;
    /** Record a winning genome keyed by the repo profile it succeeded on. */
    writeGenome(profile: RepoProfile, genome: HarnessGenome): void;
    /**
     * Negative-memory penalty for a candidate (0..1): how similar it is to a known
     * false positive. The hybrid ranker subtracts 0.25× this, so a harness with
     * memory stops re-reporting dead hypotheses (ADR-155 §negative memory).
     */
    falsePositiveSimilarity(candidateText: string): number;
    /** Similarity of a candidate to a prior CONFIRMED finding (historical signal). */
    historicalFindingSimilarity(candidateText: string): number;
    /** Retrieve accepted patches for code similar to a weakness (patch memory). */
    retrievePatches(weaknessQuery: string, k?: number): PatchExample[];
    /**
     * Seed a population from prior winning genomes on similar repos (genome
     * memory). Returns up to `k` genomes ranked by repo-profile similarity.
     */
    seedPopulation(profile: RepoProfile, k: number): HarnessGenome[];
    /**
     * recall@k for a set of relevant code paths: of the ground-truth paths, the
     * fraction surfaced in the top-k retrieval for `query` (ADR-155 acceptance:
     * context recall@20 ≥ 0.85).
     */
    recallAtK(query: string, relevantPaths: string[], k: number): number;
}
/** Normalise a raw callgraph degree (0..~12) into a 0..1 centrality. */
export declare function centrality(degree: number): number;
/**
 * Metaproductivity lineage memory (ADR-155 Addendum B; HGM, arXiv:2510.21614).
 * The Huxley–Gödel insight: the best PARENT is not the best current scorer — it
 * is the variant whose DESCENDANTS improve fastest. ruVector cross-run seeding
 * should therefore retrieve productive LINEAGES, not just prior winners. This is
 * the metaproductivity signal that drives that selection. Pure, deterministic.
 */
export declare class LineageMemory {
    private readonly nodes;
    /** Record (or update) a variant and link it to its parent. */
    record(id: string, parentId: string | null, fitness: number): void;
    size(): number;
    /** All transitive descendant ids of a node (excluding the node itself). */
    private descendants;
    /**
     * Metaproductivity of a node: the mean fitness of its descendants (a clade-
     * metaproductivity approximation). A node with no descendants falls back to its
     * own fitness (we have no evidence its branch is productive yet). This is the
     * signal HGM selects on — NOT the node's own score.
     */
    metaproductivity(id: string): number;
    /**
     * Top-k parent ids to continue from, ranked by metaproductivity (descendant
     * potential) rather than raw fitness — so a high-scoring dead-end loses to a
     * lower-scoring node whose lineage keeps improving.
     */
    topByMetaproductivity(k: number): Array<{
        id: string;
        metaproductivity: number;
        ownFitness: number;
    }>;
    /** Top-k by raw fitness (the naive baseline metaproductivity improves on). */
    topByFitness(k: number): string[];
}
export {};
//# sourceMappingURL=memory.d.ts.map