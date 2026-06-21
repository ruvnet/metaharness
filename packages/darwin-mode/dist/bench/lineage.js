// SPDX-License-Identifier: MIT
//
// Lineage selection (ADR-076, §"Descendant-potential-aware selection") — pick
// the next parents to mutate by the PROMISE OF THE BRANCH, not just the score of
// the node. A low-scoring node that already spawned high-scoring descendants is
// a fertile lineage worth re-exploring; a high-scoring leaf with no offspring is
// a dead end. We blend three signals: the node's own score, the lift its best
// descendants show over it (descendant potential), and a structural novelty
// bonus for under-explored branches (archive diversity).
//
// Pure functions, no I/O. Every public number is rounded to 6 decimals
// (ADR-075 reproducibility clause) so re-running on the same map yields a
// byte-identical, deterministic result. Tie-breaks are by id so ranking is
// stable across runs. Dependency-free (Node built-ins only).
/**
 * Round to 6 decimal places. Kills float-representation noise so values are
 * byte-identical across runs. The leading `+` drops any `-0`. Re-implemented
 * locally to keep this module dependency-free.
 */
function round6(value) {
    return +(Math.round(value * 1e6) / 1e6).toFixed(6);
}
/**
 * Collect ALL descendant ids of `nodeId` via iterative depth-first search over
 * `children`. CYCLE-GUARDED: a `visited` set ensures a malformed tree (e.g. a
 * cycle, or a node listed twice as a child) can never infinite-loop. The start
 * node itself is not included in the result.
 *
 * @param nodeId the root of the sub-tree to enumerate.
 * @param nodes the full lineage keyed by id.
 * @returns the set of reachable descendant ids (excluding `nodeId`).
 */
function collectDescendants(nodeId, nodes) {
    const found = new Set();
    const visited = new Set([nodeId]);
    const start = nodes.get(nodeId);
    if (!start)
        return found;
    const stack = [...start.children];
    while (stack.length > 0) {
        const id = stack.pop();
        if (visited.has(id))
            continue; // cycle / re-visit guard
        visited.add(id);
        const node = nodes.get(id);
        if (!node)
            continue; // dangling child reference — skip
        found.add(id);
        for (const child of node.children) {
            if (!visited.has(child))
                stack.push(child);
        }
    }
    return found;
}
/**
 * Descendant potential: how much better this node's BEST descendants are than
 * the node itself. We take the top-`topK` descendants by score, average them,
 * and return `avgTop - node.score` (can be negative when descendants regressed).
 * A leaf — or a node whose entire sub-tree is empty — has potential 0.
 *
 * This is the core "best branch beats best agent" signal: a low-scoring node
 * that already produced high-scoring children gets a large positive lift.
 *
 * @param nodeId the node to evaluate.
 * @param nodes the full lineage keyed by id.
 * @param topK how many of the best descendants to average (default 3).
 * @returns rounded `avgTopK(descendantScores) - node.score`, or 0 if no
 *   descendants (or the node is absent).
 */
export function descendantPotential(nodeId, nodes, topK = 3) {
    const node = nodes.get(nodeId);
    if (!node)
        return 0;
    const descendants = collectDescendants(nodeId, nodes);
    if (descendants.size === 0)
        return 0;
    const scores = [];
    for (const id of descendants) {
        const d = nodes.get(id);
        if (d)
            scores.push(d.score);
    }
    if (scores.length === 0)
        return 0;
    const k = Math.max(1, Math.min(topK, scores.length));
    scores.sort((a, b) => b - a);
    let sum = 0;
    for (let i = 0; i < k; i += 1)
        sum += scores[i];
    const avgTop = sum / k;
    return round6(avgTop - node.score);
}
/**
 * Archive diversity: a structural novelty score in [0,1] that rewards
 * UNDER-explored branches. Defined as `1 / (1 + siblingCount)`, where
 * `siblingCount` is the number of OTHER children of this node's parent. A node
 * with no siblings (or a root, or a node whose parent is absent from the map)
 * scores 1; the more crowded its branch, the lower the score (3 siblings ⇒ 1/4).
 *
 * @param nodeId the node to evaluate.
 * @param nodes the full lineage keyed by id.
 * @returns rounded novelty score in (0,1].
 */
export function archiveDiversity(nodeId, nodes) {
    const node = nodes.get(nodeId);
    if (!node)
        return 1;
    // Root, or an orphan whose parent is not in the map: maximally novel.
    if (node.parentId == null)
        return 1;
    const parent = nodes.get(node.parentId);
    if (!parent)
        return 1;
    // OTHER children of the parent (exclude this node itself, once).
    const siblingCount = parent.children.filter((c) => c !== nodeId).length;
    return round6(1 / (1 + siblingCount));
}
/** ADR-076 default blend: score dominates, but branch promise and novelty count. */
const DEFAULT_WEIGHTS = {
    score: 0.7,
    potential: 0.2,
    diversity: 0.1,
};
/**
 * Combined parent-selection score for one node: a weighted blend of its own
 * score, its descendant potential, and its archive diversity. With the default
 * weights a fertile low-scoring branch can out-rank a sterile high-scoring leaf.
 *
 * @param nodeId the node to evaluate.
 * @param nodes the full lineage keyed by id.
 * @param weights optional overrides for the three signal weights.
 * @param topK forwarded to {@link descendantPotential}.
 * @returns rounded selection score, or 0 if the node is absent.
 */
export function parentSelectionScore(nodeId, nodes, weights, topK) {
    const node = nodes.get(nodeId);
    if (!node)
        return 0;
    const w = { ...DEFAULT_WEIGHTS, ...weights };
    const potential = descendantPotential(nodeId, nodes, topK);
    const diversity = archiveDiversity(nodeId, nodes);
    return round6(w.score * node.score + w.potential * potential + w.diversity * diversity);
}
/**
 * Rank ALL node ids by {@link parentSelectionScore} (descending) and return the
 * top `limit`. Tie-break is DETERMINISTIC by id ascending, so the result is
 * stable across runs. A non-positive `limit` yields an empty list.
 *
 * @param nodes the full lineage keyed by id.
 * @param limit how many parents to return.
 * @param weights optional overrides forwarded to {@link parentSelectionScore}.
 * @param topK optional, forwarded to {@link descendantPotential}.
 * @returns the top-`limit` node ids, best first.
 */
export function selectParentsByPotential(nodes, limit, weights, topK) {
    if (limit <= 0)
        return [];
    const scored = [...nodes.keys()].map((id) => ({
        id,
        score: parentSelectionScore(id, nodes, weights, topK),
    }));
    scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.slice(0, limit).map((s) => s.id);
}
//# sourceMappingURL=lineage.js.map