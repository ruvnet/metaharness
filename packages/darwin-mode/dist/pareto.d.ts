/**
 * The Pareto front: the items not dominated by any other. `objectives` returns a
 * vector per item with HIGHER = better on each axis. Order-preserving (front
 * items keep their input order → deterministic when the input is deterministic).
 */
export declare function paretoFront<T>(items: readonly T[], objectives: (t: T) => number[]): T[];
//# sourceMappingURL=pareto.d.ts.map