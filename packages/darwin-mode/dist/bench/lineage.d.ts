import type { LineageNode } from './types.js';
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
export declare function descendantPotential(nodeId: string, nodes: Map<string, LineageNode>, topK?: number): number;
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
export declare function archiveDiversity(nodeId: string, nodes: Map<string, LineageNode>): number;
/** Relative weights for the three parent-selection signals. */
export interface SelectionWeights {
    score?: number;
    potential?: number;
    diversity?: number;
}
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
export declare function parentSelectionScore(nodeId: string, nodes: Map<string, LineageNode>, weights?: SelectionWeights, topK?: number): number;
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
export declare function selectParentsByPotential(nodes: Map<string, LineageNode>, limit: number, weights?: SelectionWeights, topK?: number): string[];
//# sourceMappingURL=lineage.d.ts.map