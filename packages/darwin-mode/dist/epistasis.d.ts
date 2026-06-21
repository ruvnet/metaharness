import type { MutationSurface } from './types.js';
/**
 * A learned, symmetric epistatic-linkage graph over the seven mutation surfaces.
 * Edge weight = accumulated evidence that two surfaces are co-adapted (they
 * change together in successful lineages).
 */
export declare class LinkageGraph {
    private readonly edges;
    /** Add `weight` of co-occurrence evidence to every pair within `surfaces`. */
    record(surfaces: readonly MutationSurface[], weight: number): void;
    /** Co-adaptation weight between two surfaces (0 if never co-observed). */
    weight(a: MutationSurface, b: MutationSurface): number;
    /**
     * Surfaces linked to `a` with weight ≥ `minWeight`, strongest first
     * (deterministic: ties break by the canonical SURFACES order). Excludes `a`.
     */
    linkedTo(a: MutationSurface, minWeight?: number): MutationSurface[];
    /** Serializable snapshot (for the work-tree report); sorted for determinism. */
    toJSON(): Array<{
        pair: string;
        weight: number;
    }>;
}
/**
 * Build a linkage graph from scored lineages. Each lineage contributes the set
 * of surfaces mutated along it, weighted by its finalScore (clamped ≥ 0), so
 * surfaces that co-occur in HIGH-fitness lineages accrue the most weight. Pure.
 */
export declare function buildLinkage(lineages: ReadonlyArray<{
    surfaces: readonly MutationSurface[];
    score: number;
}>): LinkageGraph;
/**
 * The epistatic block to inherit from parentB in a topology-aware crossover: a
 * seed surface plus its strongly-linked neighbours (so co-adapted surfaces stay
 * together), kept a PROPER non-empty subset of the seven. Deterministic in
 * `(seed surface, graph)`. Falls back to just the seed when nothing is linked.
 */
export declare function linkedCrossoverBlock(graph: LinkageGraph, seedSurface: MutationSurface, minWeight?: number): MutationSurface[];
//# sourceMappingURL=epistasis.d.ts.map