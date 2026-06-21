// SPDX-License-Identifier: MIT
//
// Epistatic linkage learning (ADR-093). Crossover (ADR-089) swaps a RANDOM subset
// of surfaces between parents. But surfaces are epistatic: a `planner` change may
// only pay off when matched by a complementary `retryPolicy` change. Splitting a
// co-adapted pair destroys both. This module LEARNS which surfaces co-occur in
// high-fitness lineages and lets crossover keep linked surfaces together —
// topology-aware recombination instead of blind swapping.
//
// The linkage model is a symmetric, surface×surface co-occurrence graph weighted
// by the finalScore of the lineages a pair appears in. Dependency-free and
// deterministic. NOTE on RuVector: `ruvnet/ruvector` implements GNN message
// passing that can refine these edge weights (propagating linkage through the
// graph) at scale; this native co-occurrence graph is the dependency-free model
// that works today, behind the same `LinkageGraph` seam.
import { SURFACES } from './safety.js';
/** Sorted, stable key for an unordered surface pair. */
function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}
/**
 * A learned, symmetric epistatic-linkage graph over the seven mutation surfaces.
 * Edge weight = accumulated evidence that two surfaces are co-adapted (they
 * change together in successful lineages).
 */
export class LinkageGraph {
    edges = new Map();
    /** Add `weight` of co-occurrence evidence to every pair within `surfaces`. */
    record(surfaces, weight) {
        if (weight <= 0)
            return;
        const uniq = [...new Set(surfaces)];
        for (let i = 0; i < uniq.length; i++) {
            for (let j = i + 1; j < uniq.length; j++) {
                const k = pairKey(uniq[i], uniq[j]);
                this.edges.set(k, (this.edges.get(k) ?? 0) + weight);
            }
        }
    }
    /** Co-adaptation weight between two surfaces (0 if never co-observed). */
    weight(a, b) {
        if (a === b)
            return 0;
        return this.edges.get(pairKey(a, b)) ?? 0;
    }
    /**
     * Surfaces linked to `a` with weight ≥ `minWeight`, strongest first
     * (deterministic: ties break by the canonical SURFACES order). Excludes `a`.
     */
    linkedTo(a, minWeight = 0) {
        return SURFACES.filter((s) => s !== a && this.weight(a, s) >= minWeight && this.weight(a, s) > 0)
            .sort((x, y) => {
            const d = this.weight(a, y) - this.weight(a, x);
            return d !== 0 ? d : SURFACES.indexOf(x) - SURFACES.indexOf(y);
        });
    }
    /** Serializable snapshot (for the work-tree report); sorted for determinism. */
    toJSON() {
        return [...this.edges.entries()]
            .map(([pair, weight]) => ({ pair, weight }))
            .sort((a, b) => b.weight - a.weight || (a.pair < b.pair ? -1 : 1));
    }
}
/**
 * Build a linkage graph from scored lineages. Each lineage contributes the set
 * of surfaces mutated along it, weighted by its finalScore (clamped ≥ 0), so
 * surfaces that co-occur in HIGH-fitness lineages accrue the most weight. Pure.
 */
export function buildLinkage(lineages) {
    const graph = new LinkageGraph();
    for (const { surfaces, score } of lineages) {
        graph.record(surfaces, Math.max(0, score));
    }
    return graph;
}
/**
 * The epistatic block to inherit from parentB in a topology-aware crossover: a
 * seed surface plus its strongly-linked neighbours (so co-adapted surfaces stay
 * together), kept a PROPER non-empty subset of the seven. Deterministic in
 * `(seed surface, graph)`. Falls back to just the seed when nothing is linked.
 */
export function linkedCrossoverBlock(graph, seedSurface, minWeight = 0) {
    const block = [seedSurface, ...graph.linkedTo(seedSurface, minWeight)];
    const uniq = [...new Set(block)];
    // Keep it a proper subset (never all seven) so crossover always mixes parents.
    return uniq.length >= SURFACES.length ? uniq.slice(0, SURFACES.length - 1) : uniq;
}
//# sourceMappingURL=epistasis.js.map