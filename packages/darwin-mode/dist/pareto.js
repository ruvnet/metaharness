// SPDX-License-Identifier: MIT
//
// Multi-objective Pareto selection (ADR-100). The scorer is a scalar GATE that
// ceilings at 0.985 (ADR-072) — it cannot rank the safe, passing variants. A
// single scalar also forces a false choice between competing goods (capability
// vs. parsimony). Pareto dominance keeps the whole NON-DOMINATED front, so
// "mini" (small, cheap) and "grand" (capable) variants coexist instead of
// collapsing to one winner.
//
// Generic and pure. The caller maps each item to an objective vector where
// HIGHER is better on every axis (negate any cost objective). Deterministic.
/** Does `a` Pareto-dominate `b`? (≥ on every objective, > on at least one.) */
function dominates(a, b) {
    let strictlyBetter = false;
    for (let k = 0; k < a.length; k++) {
        if (a[k] < b[k])
            return false;
        if (a[k] > b[k])
            strictlyBetter = true;
    }
    return strictlyBetter;
}
/**
 * The Pareto front: the items not dominated by any other. `objectives` returns a
 * vector per item with HIGHER = better on each axis. Order-preserving (front
 * items keep their input order → deterministic when the input is deterministic).
 */
export function paretoFront(items, objectives) {
    const objs = items.map(objectives);
    const front = [];
    for (let i = 0; i < items.length; i++) {
        let dominated = false;
        for (let j = 0; j < items.length; j++) {
            if (i === j)
                continue;
            if (dominates(objs[j], objs[i])) {
                dominated = true;
                break;
            }
        }
        if (!dominated)
            front.push(items[i]);
    }
    return front;
}
//# sourceMappingURL=pareto.js.map