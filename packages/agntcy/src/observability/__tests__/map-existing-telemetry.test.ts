// SPDX-License-Identifier: MIT
//
// observability/map-existing-telemetry.ts — mapping fixtures shaped like the
// REAL producers: packages/router/src/index.ts `RouteResult`, packages/
// projects/src/memory-tiers.ts `MemoryHit`/`MemoryTier`, and packages/
// flywheel/src/types.ts `Score`/`PromotionDecision` (as returned by
// `meetsPromotionRule` in packages/flywheel/src/gate.ts).

import { describe, it, expect } from 'vitest';
import {
  mapEvaluationScore,
  mapExistingTelemetryToOtelAttributes,
  mapMemoryProvenance,
  mapModelRoute,
  type EvaluationScoreLike,
  type MemoryHitLike,
  type ModelRouteResultLike,
  type PromotionDecisionLike,
} from '../map-existing-telemetry.js';
import {
  AGNTCY_ATTR_EVALUATION_SCORE,
  AGNTCY_ATTR_MEMORY_PROVENANCE,
  AGNTCY_ATTR_MODEL_ROUTE,
} from '../otel-attributes.js';

// A realistic @metaharness/router `RouteResult` (from Router#route()).
const ROUTE_FIXTURE: ModelRouteResultLike = {
  id: 'claude-haiku',
  predictedQuality: 0.87,
  costPerMTok: 0.8,
  metBar: true,
};

// A realistic packages/projects/src/memory-tiers.ts `MemoryHit` (from
// TieredMemory#search('repo', ...)).
const MEMORY_HIT_FIXTURE: MemoryHitLike = { key: 'repo:build-command', score: 0.734521 };

// A realistic packages/flywheel/src/types.ts `Score`, as an Evaluator would
// return it (see packages/flywheel/__tests__ fixtures).
const SCORE_FIXTURE: EvaluationScoreLike = { primary: 12, noopRate: 0.2, costPerWin: 0.08, regressed: false };

// A realistic `PromotionDecision`, as `meetsPromotionRule` returns it.
const PROMOTE_DECISION_FIXTURE: PromotionDecisionLike = { promote: true, reasons: [] };
const REJECT_DECISION_FIXTURE: PromotionDecisionLike = { promote: false, reasons: ['cost_per_win_worsened', 'noop_rate_not_improved'] };

describe('mapModelRoute', () => {
  it('maps a RouteResult onto model.route + detail attributes', () => {
    expect(mapModelRoute(ROUTE_FIXTURE)).toEqual({
      [AGNTCY_ATTR_MODEL_ROUTE]: 'claude-haiku',
      'model.route.predicted_quality': 0.87,
      'model.route.cost_per_mtok': 0.8,
      'model.route.met_quality_bar': true,
    });
  });

  it('preserves a false metBar (best-effort routing pick) rather than dropping it', () => {
    const bestEffort: ModelRouteResultLike = { id: 'claude-opus', predictedQuality: 0.4, costPerMTok: 15, metBar: false };
    const attrs = mapModelRoute(bestEffort);
    expect(attrs['model.route.met_quality_bar']).toBe(false);
  });
});

describe('mapMemoryProvenance', () => {
  it('composes tier:key into the provenance attribute, preserving tier isolation semantics', () => {
    const attrs = mapMemoryProvenance('repo', MEMORY_HIT_FIXTURE);
    expect(attrs[AGNTCY_ATTR_MEMORY_PROVENANCE]).toBe('repo:repo:build-command');
    expect(attrs['memory.provenance.tier']).toBe('repo');
    expect(attrs['memory.provenance.key']).toBe('repo:build-command');
    expect(attrs['memory.provenance.relevance_score']).toBe(0.734521);
  });

  it('differentiates provenance by tier for the same key across isolated tiers', () => {
    const fromRisk = mapMemoryProvenance('risk', { key: 'shared-key', score: 0.5 });
    const fromCost = mapMemoryProvenance('cost', { key: 'shared-key', score: 0.5 });
    expect(fromRisk[AGNTCY_ATTR_MEMORY_PROVENANCE]).not.toBe(fromCost[AGNTCY_ATTR_MEMORY_PROVENANCE]);
  });
});

describe('mapEvaluationScore', () => {
  it('maps a Score onto evaluation.score + detail attributes with no decision supplied', () => {
    expect(mapEvaluationScore(SCORE_FIXTURE)).toEqual({
      [AGNTCY_ATTR_EVALUATION_SCORE]: 12,
      'evaluation.score.noop_rate': 0.2,
      'evaluation.score.cost_per_win': 0.08,
      'evaluation.score.regressed': false,
    });
  });

  it('adds promotion-decision detail attributes when a PromotionDecision is supplied (promoted)', () => {
    const attrs = mapEvaluationScore(SCORE_FIXTURE, PROMOTE_DECISION_FIXTURE);
    expect(attrs['evaluation.score.promoted']).toBe(true);
    expect(attrs['evaluation.score.reasons']).toBe('');
  });

  it('joins multiple rejection reasons from meetsPromotionRule deterministically', () => {
    const attrs = mapEvaluationScore(SCORE_FIXTURE, REJECT_DECISION_FIXTURE);
    expect(attrs['evaluation.score.promoted']).toBe(false);
    expect(attrs['evaluation.score.reasons']).toBe('cost_per_win_worsened;noop_rate_not_improved');
  });

  it('carries a hard safety regression through unmodified — never masks it', () => {
    const regressed: EvaluationScoreLike = { primary: 20, noopRate: 0.05, costPerWin: 0.02, regressed: true };
    expect(mapEvaluationScore(regressed)['evaluation.score.regressed']).toBe(true);
  });
});

describe('mapExistingTelemetryToOtelAttributes', () => {
  it('merges all three sources into one flat attribute bag when all are supplied', () => {
    const attrs = mapExistingTelemetryToOtelAttributes({
      modelRoute: ROUTE_FIXTURE,
      memoryProvenance: { tier: 'repo', hit: MEMORY_HIT_FIXTURE },
      evaluationScore: { score: SCORE_FIXTURE, decision: PROMOTE_DECISION_FIXTURE },
    });
    expect(attrs[AGNTCY_ATTR_MODEL_ROUTE]).toBe('claude-haiku');
    expect(attrs[AGNTCY_ATTR_MEMORY_PROVENANCE]).toBe('repo:repo:build-command');
    expect(attrs[AGNTCY_ATTR_EVALUATION_SCORE]).toBe(12);
    expect(attrs['evaluation.score.promoted']).toBe(true);
  });

  it('omits an attribute entirely (never a fabricated null/placeholder) when its source is absent', () => {
    const attrs = mapExistingTelemetryToOtelAttributes({ modelRoute: ROUTE_FIXTURE });
    expect(AGNTCY_ATTR_MODEL_ROUTE in attrs).toBe(true);
    expect(AGNTCY_ATTR_MEMORY_PROVENANCE in attrs).toBe(false);
    expect(AGNTCY_ATTR_EVALUATION_SCORE in attrs).toBe(false);
    expect('memory.provenance.tier' in attrs).toBe(false);
  });

  it('returns an empty attribute bag when no telemetry source is supplied', () => {
    expect(mapExistingTelemetryToOtelAttributes({})).toEqual({});
  });
});
