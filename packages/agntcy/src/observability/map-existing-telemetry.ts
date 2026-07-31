// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — observability/map-existing-telemetry.ts (ADR-237 §2.3)
//
// "This work is an OTel EXPORTER over existing internal telemetry, not new
// instrumentation logic" (ADR-237 §2.3). This file maps this repo's REAL
// existing model-routing / memory-provenance / evaluation-score producers onto
// the AGNTCY `model.route` / `memory.provenance` / `evaluation.score` span
// attributes (see ./otel-attributes.ts) — it computes nothing new.
//
// Real producers mapped here (types re-declared structurally, not imported —
// this package stays dependency-free per its package.json; see oasf/project.ts
// for why the same pattern is used there):
//   - model routing:      packages/router/src/index.ts        `RouteResult`
//                          { id, predictedQuality, costPerMTok, metBar }
//   - memory provenance:  packages/projects/src/memory-tiers.ts `MemoryHit<T>`
//                          { key, value, score } read from a `MemoryTier`
//                          ('working' | 'repo' | 'mutation' | 'cost' | 'risk')
//   - evaluation score:   packages/flywheel/src/types.ts        `Score`
//                          { primary, noopRate, costPerWin, regressed }
//                          + packages/flywheel/src/gate.ts `meetsPromotionRule`
//                          → `PromotionDecision` { promote, reasons }
//                          ("the frozen `meetsPromotionRule` scorer, ADR-072")

import { AGNTCY_ATTR_EVALUATION_SCORE, AGNTCY_ATTR_MEMORY_PROVENANCE, AGNTCY_ATTR_MODEL_ROUTE, type OtelAttributes } from './otel-attributes.js';

// --- structural shapes of the real producers --------------------------------

/** packages/router/src/index.ts `RouteResult`. */
export interface ModelRouteResultLike {
  id: string;
  predictedQuality: number;
  costPerMTok: number;
  metBar: boolean;
}

/** packages/projects/src/memory-tiers.ts `MemoryTier`. */
export type MemoryTierLike = 'working' | 'repo' | 'mutation' | 'cost' | 'risk';

/** packages/projects/src/memory-tiers.ts `MemoryHit<T>`, minus the generic
 * `value` payload (the OTel attribute only needs the provenance metadata). */
export interface MemoryHitLike {
  key: string;
  score: number;
}

/** packages/flywheel/src/types.ts `Score`. */
export interface EvaluationScoreLike {
  primary: number;
  noopRate: number;
  costPerWin: number;
  regressed: boolean;
}

/** packages/flywheel/src/types.ts `PromotionDecision` (returned by
 * `meetsPromotionRule` in packages/flywheel/src/gate.ts). Optional — a caller
 * may have a `Score` without having run the gate yet. */
export interface PromotionDecisionLike {
  promote: boolean;
  reasons: string[];
}

// --- individual mappers ------------------------------------------------------

/** Map a `RouteResult` onto `model.route` + detail attributes. */
export function mapModelRoute(route: ModelRouteResultLike): OtelAttributes {
  return {
    [AGNTCY_ATTR_MODEL_ROUTE]: route.id,
    'model.route.predicted_quality': route.predictedQuality,
    'model.route.cost_per_mtok': route.costPerMTok,
    'model.route.met_quality_bar': route.metBar,
  };
}

/** Map a `(tier, MemoryHit)` pair onto `memory.provenance` + detail
 * attributes. The composite `tier:key` value is what makes the attribute a
 * genuine PROVENANCE trail — which isolated tier a retrieved fact came from,
 * not just its key (tiers are structurally isolated namespaces, ADR-161). */
export function mapMemoryProvenance(tier: MemoryTierLike, hit: MemoryHitLike): OtelAttributes {
  return {
    [AGNTCY_ATTR_MEMORY_PROVENANCE]: `${tier}:${hit.key}`,
    'memory.provenance.tier': tier,
    'memory.provenance.key': hit.key,
    'memory.provenance.relevance_score': hit.score,
  };
}

/** Map a `Score` (+ optional `PromotionDecision` from `meetsPromotionRule`)
 * onto `evaluation.score` + detail attributes. `primary` is the headline
 * value — the same axis `meetsPromotionRule` treats as "must not regress". */
export function mapEvaluationScore(score: EvaluationScoreLike, decision?: PromotionDecisionLike): OtelAttributes {
  const attrs: OtelAttributes = {
    [AGNTCY_ATTR_EVALUATION_SCORE]: score.primary,
    'evaluation.score.noop_rate': score.noopRate,
    'evaluation.score.cost_per_win': score.costPerWin,
    'evaluation.score.regressed': score.regressed,
  };
  if (decision) {
    attrs['evaluation.score.promoted'] = decision.promote;
    attrs['evaluation.score.reasons'] = decision.reasons.join(';');
  }
  return attrs;
}

// --- combined entry point -----------------------------------------------------

export interface MapExistingTelemetryInput {
  modelRoute?: ModelRouteResultLike;
  memoryProvenance?: { tier: MemoryTierLike; hit: MemoryHitLike };
  evaluationScore?: { score: EvaluationScoreLike; decision?: PromotionDecisionLike };
}

/**
 * Map whichever of this repo's real telemetry sources are supplied into one
 * flat OTel span-attribute bag. Each source is independent — omit any of
 * `modelRoute` / `memoryProvenance` / `evaluationScore` when that telemetry
 * wasn't produced for this span (e.g. a span with no memory lookup omits
 * `memory.provenance` entirely, matching ADR-237 §2.3's "omit rather than
 * fabricate" rule already applied to `coordination.episode` /
 * `authorization.decision`).
 */
export function mapExistingTelemetryToOtelAttributes(input: MapExistingTelemetryInput): OtelAttributes {
  return {
    ...(input.modelRoute ? mapModelRoute(input.modelRoute) : {}),
    ...(input.memoryProvenance ? mapMemoryProvenance(input.memoryProvenance.tier, input.memoryProvenance.hit) : {}),
    ...(input.evaluationScore ? mapEvaluationScore(input.evaluationScore.score, input.evaluationScore.decision) : {}),
  };
}
