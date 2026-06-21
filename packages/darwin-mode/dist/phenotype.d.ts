import type { RunTrace } from './types.js';
/**
 * A small, bounded behaviour feature vector for one variant's traces. Each field
 * is in [0, 1]. Pure and deterministic (no wall-clock beyond the recorded
 * durations, which only affect `durationSpread`, a relative quantity).
 */
export interface BehaviorFeatures {
    /** Fraction of traces that failed (non-zero exit, timeout, or safety block). */
    failRate: number;
    /** Fraction that hit the wall-clock timeout (a deep-loop signature). */
    timeoutRate: number;
    /** Fraction that tripped a safety block. */
    blockRate: number;
    /** Output verbosity, saturated (mean stdout+stderr chars). */
    verbosity: number;
    /** Repeated-line fraction across traces — loop / backtracking proxy. */
    repetition: number;
    /** Relative duration spread (stddev/mean) — irregular vs. uniform effort. */
    durationSpread: number;
}
export declare function behaviorFeatures(traces: RunTrace[]): BehaviorFeatures;
/**
 * Embed behaviour features into the 2-D Poincaré ball (the open unit disk).
 * RADIUS encodes hierarchical "depth/struggle" (failure, looping, timeouts) —
 * deep recursive strugglers sit near the boundary where hyperbolic distance
 * explodes; clean shallow agents sit near the origin. ANGLE encodes behavioural
 * MODE (verbosity vs. safety-pressure vs. effort irregularity). The point always
 * satisfies ‖p‖ < 1.
 */
export declare function poincareEmbed(f: BehaviorFeatures): [number, number];
/**
 * Poincaré-ball distance between two points in the open unit ball:
 *
 *   d(u,v) = acosh( 1 + 2 · ‖u−v‖² / ((1−‖u‖²)(1−‖v‖²)) )
 *
 * Returns 0 for identical points, is symmetric, and grows without bound as
 * either point approaches the boundary. Guards the denominator for points placed
 * exactly on the boundary (treated as just inside).
 */
export declare function poincareDistance(u: readonly number[], v: readonly number[]): number;
/**
 * Assign a discrete behavioural niche by hyperbolic region: a radial shell
 * (hierarchy depth) crossed with an angular sector (behavioural mode). Same
 * behaviour ⇒ same niche; deterministic. Plugs into `selectElites` as the
 * descriptor: `selectElites(k, v => behavioralNiche(tracesById.get(v.id) ?? []))`.
 */
/** Poincaré polar niche of a disk point: radial shell (depth) × angular sector. */
export declare function poincareNicheOf(x: number, y: number, shells?: number, sectors?: number): string;
/** Flat Cartesian niche of a disk point: a uniform `bins × bins` square grid. */
export declare function euclideanNicheOf(x: number, y: number, bins?: number): string;
export declare function behavioralNiche(traces: RunTrace[], shells?: number, sectors?: number): string;
/**
 * FLAT Euclidean niche over the SAME embedded behaviour point — a square
 * `bins × bins` grid on the disk. This is the ablation comparator for ADR-095:
 * it bins the identical `poincareEmbed` coordinate with a uniform Cartesian grid
 * instead of the polar/hyperbolic radial-shell grid, so a controlled run can
 * measure what the hyperbolic geometry actually buys. Deterministic.
 */
export declare function euclideanNiche(traces: RunTrace[], bins?: number): string;
/** Geometric centroid of niche cell `(shell, sector)` in the Poincaré disk. */
export declare function nicheCentroid(shell: number, sector: number, shells?: number, sectors?: number): [number, number];
/**
 * Find an under-explored target niche: scan shells from the OUTSIDE in (prefer
 * the high-radius complexity frontier, per open-endedness) and return the first
 * unoccupied cell's id + centroid. Returns `null` when every niche is occupied.
 */
export declare function underExploredTarget(occupied: ReadonlySet<string>, shells?: number, sectors?: number): {
    niche: string;
    centroid: [number, number];
} | null;
/**
 * Rank candidates by Poincaré distance to `target` (ascending) and return the
 * nearest `limit` ids — the survivors whose offspring are most likely to reach
 * the under-explored region. Ties break by the candidate array order (the caller
 * supplies a deterministic order, e.g. archive insertion).
 */
export declare function nearestToTarget(candidates: ReadonlyArray<{
    id: string;
    embed: readonly [number, number];
}>, target: readonly [number, number], limit: number): string[];
/** Convenience: the Poincaré embedding of a variant straight from its traces. */
export declare function embedTraces(traces: RunTrace[]): [number, number];
//# sourceMappingURL=phenotype.d.ts.map