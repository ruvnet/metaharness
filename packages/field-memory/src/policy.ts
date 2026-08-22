import type { FieldMemoryConfig, ResolvedFieldMemoryConfig, VectorMetric } from './types.js';

const DAY = 86_400_000;

export const FIELD_MEMORY_DEFAULTS = Object.freeze({
  similarity: 'cosine' as VectorMetric,
  retrievalK: 8,
  minimumSimilarity: 0,
  minimumSupport: 3,
  minimumTrustDomains: 1,
  decayHalfLifeMs: 7 * DAY,
  driftWindowMs: 30 * DAY,
  bucketSizeMs: DAY,
  influenceWindowMs: 30 * DAY,
  idempotencyWindowMs: 30 * DAY,
  maxContributionWeight: 1,
  principalInfluenceCap: 3,
  trustDomainInfluenceCap: 12,
  maxAggregateWeight: 10_000,
  maxRecordedCost: 1_000_000,
  maxVectorMagnitude: 1_000_000,
  maxConfigurationsPerCentroid: 64,
  maxCentroids: 100_000,
  maxSubjectsPerCentroid: 4_096,
  maxIdempotencyMarkersPerCentroid: 16_384,
  costPenaltyWeight: 0.1,
  costScale: 1,
  priorWeight: 1,
  semanticWeight: 0.25,
  hysteresisMargin: 0,
  semanticContinuityThreshold: 0.85,
  maxFutureSkewMs: 5 * 60_000,
});

function finite(name: string, value: number, min: number, max: number, integer = false): void {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer ' : ''}in [${min}, ${max}]`);
  }
}

export function resolveConfig(input: FieldMemoryConfig): ResolvedFieldMemoryConfig {
  const config: ResolvedFieldMemoryConfig = { ...FIELD_MEMORY_DEFAULTS, ...input };

  finite('dimension', config.dimension, 1, 65_536, true);
  if (!(['cosine', 'dot', 'euclidean'] as const).includes(config.similarity)) {
    throw new TypeError('similarity must be cosine, dot, or euclidean');
  }
  finite('retrievalK', config.retrievalK, 1, 10_000, true);
  finite('minimumSimilarity', config.minimumSimilarity, -1, 1);
  finite('minimumSupport', config.minimumSupport, 1, 10_000, true);
  finite('minimumTrustDomains', config.minimumTrustDomains, 1, 10_000, true);
  if (config.minimumTrustDomains > config.minimumSupport) {
    throw new RangeError('minimumTrustDomains cannot exceed minimumSupport');
  }
  finite('decayHalfLifeMs', config.decayHalfLifeMs, 1, Number.MAX_SAFE_INTEGER, true);
  finite('driftWindowMs', config.driftWindowMs, 1, Number.MAX_SAFE_INTEGER, true);
  finite('bucketSizeMs', config.bucketSizeMs, 1, Number.MAX_SAFE_INTEGER, true);
  if (config.bucketSizeMs > config.driftWindowMs) {
    throw new RangeError('bucketSizeMs cannot exceed driftWindowMs');
  }
  finite('influenceWindowMs', config.influenceWindowMs, config.bucketSizeMs, Number.MAX_SAFE_INTEGER, true);
  if (config.influenceWindowMs < config.driftWindowMs) {
    throw new RangeError('influenceWindowMs cannot be shorter than driftWindowMs');
  }
  finite('idempotencyWindowMs', config.idempotencyWindowMs, config.bucketSizeMs, Number.MAX_SAFE_INTEGER, true);
  finite('maxContributionWeight', config.maxContributionWeight, 1e-12, 1_000_000);
  finite('principalInfluenceCap', config.principalInfluenceCap, 1e-12, 1_000_000);
  finite('trustDomainInfluenceCap', config.trustDomainInfluenceCap, 1e-12, 10_000_000);
  finite('maxAggregateWeight', config.maxAggregateWeight, 1e-12, 1_000_000_000);
  finite('maxRecordedCost', config.maxRecordedCost, 0, 1_000_000_000_000);
  finite('maxVectorMagnitude', config.maxVectorMagnitude, Number.EPSILON, 1e150);
  finite('maxConfigurationsPerCentroid', config.maxConfigurationsPerCentroid, 1, 10_000, true);
  finite('maxCentroids', config.maxCentroids, 1, 10_000_000, true);
  finite('maxSubjectsPerCentroid', config.maxSubjectsPerCentroid, 1, 1_000_000, true);
  finite('maxIdempotencyMarkersPerCentroid', config.maxIdempotencyMarkersPerCentroid, 1, 10_000_000, true);
  if (config.minimumSupport > config.maxSubjectsPerCentroid) {
    throw new RangeError('minimumSupport cannot exceed maxSubjectsPerCentroid');
  }
  finite('costPenaltyWeight', config.costPenaltyWeight, 0, 1_000_000);
  finite('costScale', config.costScale, Number.EPSILON, 1_000_000_000_000);
  finite('priorWeight', config.priorWeight, Number.EPSILON, 1_000_000);
  finite('semanticWeight', config.semanticWeight, 0, 1_000_000);
  finite('hysteresisMargin', config.hysteresisMargin, 0, 1_000_000);
  finite('semanticContinuityThreshold', config.semanticContinuityThreshold, -1, 1);
  finite('maxFutureSkewMs', config.maxFutureSkewMs, 0, Number.MAX_SAFE_INTEGER, true);

  return Object.freeze(config);
}
