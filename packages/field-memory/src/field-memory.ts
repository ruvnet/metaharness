import {
  FIELD_MEMORY_SCHEMA_VERSION,
  type CompactOptions,
  type CompactResult,
  type EmbeddingBucket,
  type FieldChoice,
  type FieldChoiceCandidate,
  type FieldChoiceInput,
  type FieldMemoryOptions,
  type FieldMemoryState,
  type FieldMemoryStatePayload,
  type FieldStorageAdapter,
  type FieldUpdate,
  type IdempotencyMarker,
  type ImportStateOptions,
  type InfluenceBucket,
  type InfluenceLedger,
  type PackedCentroidRecord,
  type ResolvedFieldMemoryConfig,
  type RewardBucket,
  type RewardHead,
  type UpdateReceipt,
  type VerifiableFieldUpdate,
  type VerifiedPrincipal,
} from './types.js';
import { resolveConfig } from './policy.js';
import { InMemoryFieldStorage } from './storage.js';
import {
  activeSince,
  assertIdentityHashKey,
  assertIdentifier,
  assertTimestamp,
  assertVector,
  bucketStart,
  canonicalJson,
  clone,
  compareText,
  cosine,
  decay,
  digestOpaque,
  floorWeight,
  hmacSha256,
  normalized,
  round,
  secureHexEqual,
  vectorNorm,
} from './util.js';

const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_SCALARS = 1_000_000;
const MIN_CONTRIBUTION_WEIGHT = 1e-12;
const HASH = /^[a-f0-9]{64}$/u;

interface ImportBudget {
  remaining: number;
}

interface HeadMetrics {
  eligible: boolean;
  rewardScore: number;
  meanCost: number;
  costScore: number;
  effectiveWeight: number;
  principals: Set<string>;
  trustDomains: Set<string>;
}

interface CandidateAccumulator {
  configurationId: string;
  weightedScore: number;
  weightedReward: number;
  weightedMeanCost: number;
  totalAffinity: number;
  effectiveWeight: number;
  bestSimilarity: number;
  principals: Set<string>;
  trustDomains: Set<string>;
  centroidIds: Set<string>;
}

function emptyReceipt(
  status: UpdateReceipt['status'],
  update: VerifiableFieldUpdate,
  requestedWeight: number,
): UpdateReceipt {
  return {
    status,
    centroidId: update.centroidId,
    configurationId: update.configurationId,
    acceptedWeight: 0,
    requestedWeight,
    contributionClamped: false,
    support: 0,
    trustDomains: 0,
    eligible: false,
    revision: null,
  };
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function addToBucket<T extends { start: number; lastUpdatedAt: number }>(
  buckets: T[],
  start: number,
  create: () => T,
): T {
  let bucket = buckets.find((candidate) => candidate.start === start);
  if (!bucket) {
    bucket = create();
    buckets.push(bucket);
    buckets.sort((a, b) => a.start - b.start);
  }
  return bucket;
}

function sumActiveInfluence(ledger: InfluenceLedger | undefined, since: number): number {
  return round(
    (ledger?.buckets ?? [])
      .filter((bucket) => bucket.lastUpdatedAt >= since)
      .reduce((sum, bucket) => sum + bucket.weight, 0),
  );
}

function totalEmbeddingWeight(record: PackedCentroidRecord, since: number): number {
  return round(
    record.heads.reduce(
      (sum, head) => sum + head.embeddingBuckets
        .filter((bucket) => bucket.lastUpdatedAt >= since)
        .reduce((subtotal, bucket) => subtotal + bucket.weight, 0),
      0,
    ),
  );
}

function addFinite(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isFinite(result)) throw new RangeError(`${label} produced a non-finite value`);
  return Object.is(result, -0) ? 0 : result;
}

function activeEmbeddingSum(
  head: RewardHead,
  now: number,
  config: ResolvedFieldMemoryConfig,
): number[] {
  const since = activeSince(now, config.driftWindowMs);
  const sum = Array.from({ length: config.dimension }, () => 0);
  for (const bucket of head.embeddingBuckets) {
    if (bucket.lastUpdatedAt < since) continue;
    for (let index = 0; index < config.dimension; index += 1) {
      sum[index] = addFinite(sum[index], bucket.weightedSum[index], 'embedding aggregation');
    }
  }
  return sum;
}

function sortRecord(record: PackedCentroidRecord): PackedCentroidRecord {
  const result = clone(record);
  result.embeddingBuckets.sort((a, b) => a.start - b.start);
  for (const head of result.heads) {
    head.embeddingBuckets.sort((a, b) => a.start - b.start);
    head.buckets.sort((a, b) => a.start - b.start);
    for (const bucket of head.buckets) {
      bucket.principalHashes = sortUnique(bucket.principalHashes);
      bucket.trustDomainHashes = sortUnique(bucket.trustDomainHashes);
    }
  }
  result.heads.sort((a, b) => compareText(a.configurationId, b.configurationId));
  for (const ledger of [...result.principalInfluence, ...result.trustDomainInfluence]) {
    ledger.buckets.sort((a, b) => a.start - b.start);
  }
  result.principalInfluence.sort((a, b) => compareText(a.subjectHash, b.subjectHash));
  result.trustDomainInfluence.sort((a, b) => compareText(a.subjectHash, b.subjectHash));
  result.idempotency.sort((a, b) => a.observedAt - b.observedAt || compareText(a.digest, b.digest));
  return result;
}

function countBuckets(record: PackedCentroidRecord): number {
  return (
    record.embeddingBuckets.length
    + record.heads.reduce((sum, head) => sum + head.embeddingBuckets.length + head.buckets.length, 0)
    + record.principalInfluence.reduce((sum, ledger) => sum + ledger.buckets.length, 0)
    + record.trustDomainInfluence.reduce((sum, ledger) => sum + ledger.buckets.length, 0)
  );
}

function recomputeVector(record: PackedCentroidRecord, config: ResolvedFieldMemoryConfig): boolean {
  const weightedSum = Array.from({ length: config.dimension }, () => 0);
  let weight = 0;
  for (const bucket of record.embeddingBuckets) {
    weight = addFinite(weight, bucket.weight, 'embedding weight aggregation');
    for (let index = 0; index < config.dimension; index += 1) {
      weightedSum[index] = addFinite(
        weightedSum[index],
        bucket.weightedSum[index],
        'embedding aggregation',
      );
    }
  }
  if (weight <= Number.EPSILON) return false;
  const mean = weightedSum.map((value) => value / weight);
  if (config.similarity !== 'euclidean' && vectorNorm(mean) <= Number.EPSILON) return false;
  record.vector = normalized(mean, config.similarity);
  return true;
}

function rebuildPublishedEmbedding(
  record: PackedCentroidRecord,
  now: number,
  config: ResolvedFieldMemoryConfig,
): void {
  const since = activeSince(now, config.driftWindowMs);
  const published = new Map<number, EmbeddingBucket>();
  for (const head of [...record.heads].sort((a, b) => compareText(a.configurationId, b.configurationId))) {
    if (!metricsForHead(head, now, config).eligible) continue;
    for (const source of [...head.embeddingBuckets].sort((a, b) => a.start - b.start)) {
      if (source.lastUpdatedAt < since) continue;
      let target = published.get(source.start);
      if (!target) {
        target = {
          start: source.start,
          lastUpdatedAt: source.lastUpdatedAt,
          weight: 0,
          weightedSum: Array.from({ length: config.dimension }, () => 0),
        };
        published.set(source.start, target);
      }
      target.lastUpdatedAt = Math.max(target.lastUpdatedAt, source.lastUpdatedAt);
      target.weight = round(target.weight + source.weight);
      for (let index = 0; index < config.dimension; index += 1) {
        target.weightedSum[index] = addFinite(
          target.weightedSum[index],
          source.weightedSum[index],
          'published embedding aggregation',
        );
      }
    }
  }
  record.embeddingBuckets = [...published.values()].sort((a, b) => a.start - b.start);
  record.searchable = record.embeddingBuckets.length > 0;
  if (record.searchable && !recomputeVector(record, config)) {
    record.embeddingBuckets = [];
    record.searchable = false;
  }
  if (!record.searchable) record.vector = Array.from({ length: config.dimension }, () => 0);
}

function pruneRecord(
  input: PackedCentroidRecord,
  now: number,
  config: ResolvedFieldMemoryConfig,
): PackedCentroidRecord {
  const record = clone(input);
  const fieldSince = activeSince(now, config.driftWindowMs);
  const influenceSince = activeSince(now, config.influenceWindowMs);
  const idempotencySince = activeSince(now, config.idempotencyWindowMs);

  record.embeddingBuckets = record.embeddingBuckets.filter((bucket) => bucket.lastUpdatedAt >= fieldSince);
  record.heads = record.heads
    .map((head) => ({
      ...head,
      embeddingBuckets: head.embeddingBuckets.filter((bucket) => bucket.lastUpdatedAt >= fieldSince),
      buckets: head.buckets.filter((bucket) => bucket.lastUpdatedAt >= fieldSince),
    }))
    .filter((head) => head.embeddingBuckets.length > 0 && head.buckets.length > 0)
    .map((head) => ({
      ...head,
      lastUpdatedAt: Math.max(...head.buckets.map((bucket) => bucket.lastUpdatedAt)),
    }));
  record.principalInfluence = record.principalInfluence
    .map((ledger) => ({
      ...ledger,
      buckets: ledger.buckets.filter((bucket) => bucket.lastUpdatedAt >= influenceSince),
    }))
    .filter((ledger) => ledger.buckets.length > 0);
  record.trustDomainInfluence = record.trustDomainInfluence
    .map((ledger) => ({
      ...ledger,
      buckets: ledger.buckets.filter((bucket) => bucket.lastUpdatedAt >= influenceSince),
    }))
    .filter((ledger) => ledger.buckets.length > 0);
  record.idempotency = record.idempotency.filter((marker) => marker.observedAt >= idempotencySince);
  rebuildPublishedEmbedding(record, now, config);
  return sortRecord(record);
}

function metricsForHead(head: RewardHead, now: number, config: ResolvedFieldMemoryConfig): HeadMetrics {
  const since = activeSince(now, config.driftWindowMs);
  let effectiveWeight = 0;
  let rewardSum = 0;
  let costSum = 0;
  const principals = new Set<string>();
  const trustDomains = new Set<string>();

  for (const bucket of head.buckets) {
    if (bucket.lastUpdatedAt < since) continue;
    const factor = decay(now - bucket.lastUpdatedAt, config.decayHalfLifeMs);
    effectiveWeight += bucket.weight * factor;
    rewardSum += bucket.rewardSum * factor;
    costSum += bucket.costSum * factor;
    for (const hash of bucket.principalHashes) principals.add(hash);
    for (const hash of bucket.trustDomainHashes) trustDomains.add(hash);
  }

  effectiveWeight = round(effectiveWeight);
  const denominator = config.priorWeight + effectiveWeight;
  const rewardScore = round(rewardSum / denominator);
  const costScore = round(costSum / denominator);
  const meanCost = effectiveWeight > Number.EPSILON ? round(costSum / effectiveWeight) : 0;
  return {
    eligible:
      principals.size >= config.minimumSupport
      && trustDomains.size >= config.minimumTrustDomains
      && effectiveWeight > Number.EPSILON
      && (
        config.similarity === 'euclidean'
        || vectorNorm(activeEmbeddingSum(head, now, config)) > Number.EPSILON
      ),
    rewardScore,
    meanCost,
    costScore,
    effectiveWeight,
    principals,
    trustDomains,
  };
}

function validateUpdate(update: VerifiableFieldUpdate, config: ResolvedFieldMemoryConfig): number {
  assertIdentifier('centroidId', update.centroidId);
  assertIdentifier('configurationId', update.configurationId);
  assertIdentifier('idempotencyKey', update.idempotencyKey);
  assertVector(update.embedding, config.dimension);
  if (config.similarity === 'euclidean' && vectorNorm(update.embedding) > config.maxVectorMagnitude) {
    throw new RangeError(`embedding magnitude exceeds maxVectorMagnitude ${config.maxVectorMagnitude}`);
  }
  if (!Number.isFinite(update.reward) || update.reward < -1 || update.reward > 1) {
    throw new RangeError('reward must be finite and in [-1, 1]');
  }
  if (!Number.isFinite(update.cost) || update.cost < 0 || update.cost > config.maxRecordedCost) {
    throw new RangeError(`cost must be finite and in [0, ${config.maxRecordedCost}]`);
  }
  assertTimestamp('observedAt', update.observedAt);
  const start = bucketStart(update.observedAt, config.bucketSizeMs);
  if (!Number.isSafeInteger(start + config.bucketSizeMs)) {
    throw new RangeError('observedAt cannot be represented within the configured bucket size');
  }
  const requestedWeight = update.weight ?? 1;
  if (!Number.isFinite(requestedWeight) || requestedWeight < MIN_CONTRIBUTION_WEIGHT) {
    throw new RangeError(`weight must be finite and at least ${MIN_CONTRIBUTION_WEIGHT}`);
  }
  return requestedWeight;
}

function assertVerifiedPrincipal(value: VerifiedPrincipal): void {
  assertIdentifier('verified principalId', value.principalId);
  assertIdentifier('verified trustDomain', value.trustDomain);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(object: Record<string, unknown>, key: string, min = 0): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TypeError(`invalid state field: ${key}`);
  }
  return value;
}

function integerField(object: Record<string, unknown>, key: string, min = 0): number {
  const value = numberField(object, key, min);
  if (!Number.isSafeInteger(value)) throw new TypeError(`invalid integer state field: ${key}`);
  return value;
}

function stringField(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw new TypeError(`invalid state field: ${key}`);
  return value;
}

function arrayField(object: Record<string, unknown>, key: string): unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new TypeError(`invalid state field: ${key}`);
  return value;
}

function consume(budget: ImportBudget, count: number): void {
  budget.remaining -= count;
  if (budget.remaining < 0) throw new RangeError('state exceeds object-form import complexity limit');
}

function countScalars(value: unknown, limit = MAX_IMPORT_SCALARS): number {
  const stack: unknown[] = [value];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      count += current.length;
      if (count > limit) throw new RangeError('state exceeds object-form scalar limit');
      for (const item of current) stack.push(item);
    } else if (isRecordObject(current)) {
      const values = Object.values(current);
      count += values.length;
      if (count > limit) throw new RangeError('state exceeds object-form scalar limit');
      for (const item of values) stack.push(item);
    }
  }
  return count;
}

function exactKeys(object: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(object).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function aggregateMagnitudeExceeds(norm: number, weight: number): boolean {
  const tolerance = Math.max(Number.EPSILON * 8, Math.abs(weight) * 1e-9);
  return norm > weight + tolerance;
}

function assertBucketTime(
  start: number,
  lastUpdatedAt: number,
  recordCreatedAt: number,
  recordUpdatedAt: number,
  config: ResolvedFieldMemoryConfig,
): void {
  if (start % config.bucketSizeMs !== 0) throw new TypeError('bucket start is not policy-aligned');
  if (!Number.isSafeInteger(start + config.bucketSizeMs)) throw new TypeError('bucket range exceeds safe integers');
  if (lastUpdatedAt < start || lastUpdatedAt >= start + config.bucketSizeMs) {
    throw new TypeError('bucket timestamp falls outside its bucket');
  }
  if (lastUpdatedAt < recordCreatedAt || lastUpdatedAt > recordUpdatedAt) {
    throw new TypeError('bucket timestamp falls outside record bounds');
  }
}

/** Parse into a fresh known-shape object; adapters never receive attacker-added keys. */
function parseRecord(value: unknown, config: ResolvedFieldMemoryConfig, budget: ImportBudget): PackedCentroidRecord {
  if (!isRecordObject(value)) throw new TypeError('invalid centroid record');
  exactKeys(value, [
    'id', 'searchable', 'vector', 'embeddingBuckets', 'heads', 'principalInfluence', 'trustDomainInfluence',
    'idempotency', 'createdAt', 'updatedAt', 'revision',
  ], 'centroid record');
  const id = stringField(value, 'id');
  assertIdentifier('centroid id', id);
  const createdAt = integerField(value, 'createdAt');
  const updatedAt = integerField(value, 'updatedAt');
  if (createdAt > updatedAt) throw new TypeError('createdAt cannot exceed updatedAt');
  const searchable = value.searchable;
  if (typeof searchable !== 'boolean') throw new TypeError('invalid searchable field');

  const vectorValues = arrayField(value, 'vector');
  consume(budget, vectorValues.length);
  const vector = vectorValues.map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new TypeError('invalid centroid vector');
    return entry;
  });
  assertVector(vector, config.dimension, 'centroid vector');
  if (config.similarity === 'euclidean' && vectorNorm(vector) > config.maxVectorMagnitude) {
    throw new TypeError('centroid vector magnitude exceeds policy');
  }

  const embeddingEntries = arrayField(value, 'embeddingBuckets');
  const maxFieldBuckets = Math.ceil(config.driftWindowMs / config.bucketSizeMs) + 1;
  if (embeddingEntries.length > maxFieldBuckets) throw new RangeError('too many embedding buckets');
  consume(budget, embeddingEntries.length);
  if (searchable && embeddingEntries.length === 0) throw new RangeError('searchable centroid must contain an embedding bucket');
  if (!searchable && embeddingEntries.length !== 0) throw new TypeError('quarantined centroid cannot publish embedding buckets');
  const embeddingBuckets: EmbeddingBucket[] = embeddingEntries.map((entry) => {
    if (!isRecordObject(entry)) throw new TypeError('invalid embedding bucket');
    exactKeys(entry, ['start', 'lastUpdatedAt', 'weight', 'weightedSum'], 'embedding bucket');
    const sumValues = arrayField(entry, 'weightedSum');
    consume(budget, sumValues.length);
    const weightedSum = sumValues.map((item) => {
      if (typeof item !== 'number' || !Number.isFinite(item)) throw new TypeError('invalid embedding aggregate');
      return item;
    });
    assertVector(weightedSum, config.dimension, 'embedding aggregate');
    const result = {
      start: integerField(entry, 'start'),
      lastUpdatedAt: integerField(entry, 'lastUpdatedAt'),
      weight: numberField(entry, 'weight', Number.EPSILON),
      weightedSum,
    };
    assertBucketTime(result.start, result.lastUpdatedAt, createdAt, updatedAt, config);
    if (config.similarity !== 'euclidean' && aggregateMagnitudeExceeds(vectorNorm(weightedSum), result.weight)) {
      throw new TypeError('published embedding aggregate magnitude exceeds its weight');
    }
    if (result.lastUpdatedAt < activeSince(updatedAt, config.driftWindowMs)) {
      throw new TypeError('embedding bucket falls outside the active field window');
    }
    return result;
  });
  if (!unique(embeddingBuckets.map((bucket) => bucket.start))) throw new TypeError('duplicate embedding bucket start');

  const headEntries = arrayField(value, 'heads');
  if (headEntries.length > config.maxConfigurationsPerCentroid) {
    throw new RangeError('invalid reward head count');
  }
  consume(budget, headEntries.length);
  const heads: RewardHead[] = headEntries.map((entry) => {
    if (!isRecordObject(entry)) throw new TypeError('invalid reward head');
    exactKeys(entry, ['configurationId', 'lastUpdatedAt', 'embeddingBuckets', 'buckets'], 'reward head');
    const configurationId = stringField(entry, 'configurationId');
    assertIdentifier('configuration id', configurationId);
    const headEmbeddingEntries = arrayField(entry, 'embeddingBuckets');
    if (headEmbeddingEntries.length === 0 || headEmbeddingEntries.length > maxFieldBuckets) {
      throw new RangeError('invalid head embedding bucket count');
    }
    consume(budget, headEmbeddingEntries.length);
    const headEmbeddingBuckets: EmbeddingBucket[] = headEmbeddingEntries.map((bucket) => {
      if (!isRecordObject(bucket)) throw new TypeError('invalid head embedding bucket');
      exactKeys(bucket, ['start', 'lastUpdatedAt', 'weight', 'weightedSum'], 'head embedding bucket');
      const sumValues = arrayField(bucket, 'weightedSum');
      consume(budget, sumValues.length);
      const weightedSum = sumValues.map((item) => {
        if (typeof item !== 'number' || !Number.isFinite(item)) throw new TypeError('invalid head embedding aggregate');
        return item;
      });
      assertVector(weightedSum, config.dimension, 'head embedding aggregate');
      const result: EmbeddingBucket = {
        start: integerField(bucket, 'start'),
        lastUpdatedAt: integerField(bucket, 'lastUpdatedAt'),
        weight: numberField(bucket, 'weight', Number.EPSILON),
        weightedSum,
      };
      assertBucketTime(result.start, result.lastUpdatedAt, createdAt, updatedAt, config);
      if (result.lastUpdatedAt < activeSince(updatedAt, config.driftWindowMs)) {
        throw new TypeError('head embedding bucket falls outside the active field window');
      }
      if (
        config.similarity === 'euclidean'
        && vectorNorm(weightedSum) > result.weight * config.maxVectorMagnitude + 1e-8
      ) {
        throw new TypeError('head embedding aggregate magnitude exceeds policy');
      }
      if (
        config.similarity !== 'euclidean'
        && aggregateMagnitudeExceeds(vectorNorm(weightedSum), result.weight)
      ) {
        throw new TypeError('head embedding aggregate magnitude exceeds its weight');
      }
      return result;
    });
    if (!unique(headEmbeddingBuckets.map((bucket) => bucket.start))) {
      throw new TypeError('duplicate head embedding bucket start');
    }
    const bucketEntries = arrayField(entry, 'buckets');
    if (bucketEntries.length === 0 || bucketEntries.length > maxFieldBuckets) {
      throw new RangeError('invalid reward bucket count');
    }
    consume(budget, bucketEntries.length);
    const buckets: RewardBucket[] = bucketEntries.map((bucket) => {
      if (!isRecordObject(bucket)) throw new TypeError('invalid reward bucket');
      exactKeys(bucket, [
        'start', 'lastUpdatedAt', 'weight', 'rewardSum', 'costSum', 'updates',
        'principalHashes', 'trustDomainHashes',
      ], 'reward bucket');
      const weight = numberField(bucket, 'weight', Number.EPSILON);
      const rewardSum = numberField(bucket, 'rewardSum', -Number.MAX_VALUE);
      const costSum = numberField(bucket, 'costSum');
      if (Math.abs(rewardSum) > weight + 1e-8) throw new TypeError('reward aggregate exceeds its weight');
      if (costSum > weight * config.maxRecordedCost + 1e-8) throw new TypeError('cost aggregate exceeds policy');
      const principalEntries = arrayField(bucket, 'principalHashes');
      const domainEntries = arrayField(bucket, 'trustDomainHashes');
      if (principalEntries.length > config.maxSubjectsPerCentroid || domainEntries.length > config.maxSubjectsPerCentroid) {
        throw new RangeError('reward bucket support exceeds subject cardinality policy');
      }
      consume(budget, principalEntries.length + domainEntries.length);
      const principalHashes = principalEntries.map((item) => {
        if (typeof item !== 'string' || !HASH.test(item)) throw new TypeError('invalid principal hash');
        return item;
      });
      const trustDomainHashes = domainEntries.map((item) => {
        if (typeof item !== 'string' || !HASH.test(item)) throw new TypeError('invalid trust-domain hash');
        return item;
      });
      if (!unique(principalHashes) || !unique(trustDomainHashes)) throw new TypeError('duplicate support hash');
      const result = {
        start: integerField(bucket, 'start'),
        lastUpdatedAt: integerField(bucket, 'lastUpdatedAt'),
        weight,
        rewardSum,
        costSum,
        updates: integerField(bucket, 'updates', 1),
        principalHashes: sortUnique(principalHashes),
        trustDomainHashes: sortUnique(trustDomainHashes),
      };
      assertBucketTime(result.start, result.lastUpdatedAt, createdAt, updatedAt, config);
      if (result.lastUpdatedAt < activeSince(updatedAt, config.driftWindowMs)) {
        throw new TypeError('reward bucket falls outside the active field window');
      }
      return result;
    });
    if (!unique(buckets.map((bucket) => bucket.start))) throw new TypeError('duplicate reward bucket start');
    const lastUpdatedAt = integerField(entry, 'lastUpdatedAt');
    if (lastUpdatedAt !== Math.max(...buckets.map((bucket) => bucket.lastUpdatedAt))) {
      throw new TypeError('reward head timestamp is inconsistent with its buckets');
    }
    return {
      configurationId,
      lastUpdatedAt,
      embeddingBuckets: headEmbeddingBuckets,
      buckets,
    };
  });
  if (!unique(heads.map((head) => head.configurationId))) throw new TypeError('duplicate reward head configuration');

  const parseInfluence = (key: 'principalInfluence' | 'trustDomainInfluence'): InfluenceLedger[] =>
    (() => {
      const entries = arrayField(value, key);
      if (entries.length > config.maxSubjectsPerCentroid) throw new RangeError('too many influence subjects');
      consume(budget, entries.length);
      const ledgers = entries.map((entry) => {
      if (!isRecordObject(entry)) throw new TypeError('invalid influence ledger');
      exactKeys(entry, ['subjectHash', 'buckets'], 'influence ledger');
      const subjectHash = stringField(entry, 'subjectHash');
      if (!HASH.test(subjectHash)) throw new TypeError('invalid influence subject hash');
      const bucketEntries = arrayField(entry, 'buckets');
      const maxInfluenceBuckets = Math.ceil(config.influenceWindowMs / config.bucketSizeMs) + 1;
      if (bucketEntries.length === 0 || bucketEntries.length > maxInfluenceBuckets) {
        throw new RangeError('invalid influence bucket count');
      }
      consume(budget, bucketEntries.length);
      const buckets: InfluenceBucket[] = bucketEntries.map((bucket) => {
        if (!isRecordObject(bucket)) throw new TypeError('invalid influence bucket');
        exactKeys(bucket, ['start', 'lastUpdatedAt', 'weight'], 'influence bucket');
        const result = {
          start: integerField(bucket, 'start'),
          lastUpdatedAt: integerField(bucket, 'lastUpdatedAt'),
          weight: numberField(bucket, 'weight', Number.EPSILON),
        };
        assertBucketTime(result.start, result.lastUpdatedAt, createdAt, updatedAt, config);
        if (result.lastUpdatedAt < activeSince(updatedAt, config.influenceWindowMs)) {
          throw new TypeError('influence bucket falls outside the active influence window');
        }
        return result;
      });
      if (!unique(buckets.map((bucket) => bucket.start))) throw new TypeError('duplicate influence bucket start');
      return { subjectHash, buckets };
      });
      if (!unique(ledgers.map((ledger) => ledger.subjectHash))) throw new TypeError('duplicate influence subject');
      return ledgers;
    })();

  const idempotencyEntries = arrayField(value, 'idempotency');
  if (idempotencyEntries.length > config.maxIdempotencyMarkersPerCentroid) {
    throw new RangeError('too many idempotency markers');
  }
  consume(budget, idempotencyEntries.length);
  const idempotency: IdempotencyMarker[] = idempotencyEntries.map((entry) => {
    if (!isRecordObject(entry)) throw new TypeError('invalid idempotency marker');
    exactKeys(entry, ['digest', 'observedAt'], 'idempotency marker');
    const digest = stringField(entry, 'digest');
    if (!HASH.test(digest)) throw new TypeError('invalid idempotency digest');
    const observedAt = integerField(entry, 'observedAt');
    if (observedAt < createdAt || observedAt > updatedAt) throw new TypeError('idempotency timestamp outside record bounds');
    if (observedAt < activeSince(updatedAt, config.idempotencyWindowMs)) {
      throw new TypeError('idempotency marker falls outside the active window');
    }
    return { digest, observedAt };
  });
  if (!unique(idempotency.map((marker) => marker.digest))) throw new TypeError('duplicate idempotency digest');

  const record: PackedCentroidRecord = {
    id,
    searchable,
    vector,
    embeddingBuckets,
    heads,
    principalInfluence: parseInfluence('principalInfluence'),
    trustDomainInfluence: parseInfluence('trustDomainInfluence'),
    idempotency,
    createdAt,
    updatedAt,
    revision: integerField(value, 'revision', 1),
  };
  if (record.searchable && config.similarity !== 'euclidean' && vectorNorm(record.vector) <= Number.EPSILON) {
    throw new TypeError('searchable centroid must have a non-zero direction');
  }
  if (
    record.heads.length === 0
    && record.principalInfluence.length === 0
    && record.trustDomainInfluence.length === 0
    && record.idempotency.length === 0
  ) {
    throw new TypeError('empty centroid tombstone is not permitted');
  }
  const principalSubjects = new Set(record.principalInfluence.map((ledger) => ledger.subjectHash));
  const domainSubjects = new Set(record.trustDomainInfluence.map((ledger) => ledger.subjectHash));
  for (const head of record.heads) {
    for (const bucket of head.buckets) {
      if (bucket.principalHashes.some((hash) => !principalSubjects.has(hash))) {
        throw new TypeError('reward support is absent from principal influence ledger');
      }
      if (bucket.trustDomainHashes.some((hash) => !domainSubjects.has(hash))) {
        throw new TypeError('reward support is absent from trust-domain influence ledger');
      }
    }
  }
  const aggregateWeight = record.heads.reduce(
    (sum, head) => sum + head.embeddingBuckets.reduce((subtotal, bucket) => subtotal + bucket.weight, 0),
    0,
  );
  if (aggregateWeight > config.maxAggregateWeight + 1e-8) throw new TypeError('aggregate weight exceeds policy');
  for (const head of record.heads) {
    const embeddingWeight = head.embeddingBuckets.reduce((sum, bucket) => sum + bucket.weight, 0);
    const rewardWeight = head.buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
    if (Math.abs(embeddingWeight - rewardWeight) > Math.max(1e-8, embeddingWeight * 1e-9)) {
      throw new TypeError('head embedding and reward aggregate weights disagree');
    }
  }
  for (const ledger of record.principalInfluence) {
    const influence = ledger.buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
    if (influence > config.principalInfluenceCap + 1e-8) throw new TypeError('principal influence exceeds policy');
  }
  for (const ledger of record.trustDomainInfluence) {
    const influence = ledger.buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
    if (influence > config.trustDomainInfluenceCap + 1e-8) throw new TypeError('trust-domain influence exceeds policy');
  }
  const expectedVectorRecord = clone(record);
  rebuildPublishedEmbedding(expectedVectorRecord, updatedAt, config);
  if (
    record.searchable !== expectedVectorRecord.searchable
    || canonicalJson(record.embeddingBuckets) !== canonicalJson(expectedVectorRecord.embeddingBuckets)
    || record.vector.some((entry, index) => Math.abs(entry - expectedVectorRecord.vector[index]) > 1e-9)
  ) {
    throw new TypeError('published centroid is inconsistent with support-eligible head aggregates');
  }
  return sortRecord(record);
}

export class FieldMemory<Proof = unknown> {
  readonly config: ResolvedFieldMemoryConfig;
  readonly storage: FieldStorageAdapter;
  readonly #verifier: FieldMemoryOptions<Proof>['verifier'];
  readonly #clock: () => number;
  readonly #identityHashKey: Uint8Array;
  readonly #identityKeyId: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: FieldMemoryOptions<Proof>) {
    this.config = resolveConfig(options.config);
    this.#identityHashKey = assertIdentityHashKey(options.identityHashKey);
    this.#identityKeyId = digestOpaque('identity-key-id', 'v1', this.#identityHashKey);
    this.#verifier = options.verifier;
    if (typeof this.#verifier !== 'function') throw new TypeError('verifier must be a function');
    this.#clock = options.clock ?? Date.now;
    this.storage = options.storage ?? new InMemoryFieldStorage({
      dimension: this.config.dimension,
      metric: this.config.similarity,
    });
    if (this.storage.dimension !== this.config.dimension) {
      throw new Error(`storage dimension ${this.storage.dimension} does not match policy ${this.config.dimension}`);
    }
    if (this.storage.metric !== this.config.similarity) {
      throw new Error(`storage metric ${this.storage.metric} does not match policy ${this.config.similarity}`);
    }
    if (!['process', 'distributed'].includes(this.storage.writerScope)) {
      throw new TypeError('storage writerScope must be process or distributed');
    }
    for (const method of ['search', 'get', 'list', 'upsert', 'delete', 'replaceAll', 'atomicMutate'] as const) {
      if (typeof this.storage[method] !== 'function') throw new TypeError(`storage must implement ${method}()`);
    }
    if (typeof this.storage.atomicReplace !== 'boolean') {
      throw new TypeError('storage atomicReplace must be boolean');
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async update(update: FieldUpdate<Proof>): Promise<UpdateReceipt> {
    const snapshot: VerifiableFieldUpdate = {
      centroidId: update.centroidId,
      embedding: Object.freeze([...update.embedding]),
      configurationId: update.configurationId,
      reward: update.reward,
      cost: update.cost,
      observedAt: update.observedAt,
      idempotencyKey: update.idempotencyKey,
      ...(update.weight === undefined ? {} : { weight: update.weight }),
    };
    const requestedWeight = validateUpdate(snapshot, this.config);
    Object.freeze(snapshot);

    // Reject obviously impossible timestamps before invoking a potentially
    // expensive deployment verifier. The authoritative check is repeated at
    // admission time inside the atomic mutation after verifier/lock latency.
    const preflightNow = this.#clock();
    assertTimestamp('clock()', preflightNow);
    if (snapshot.observedAt > preflightNow + this.config.maxFutureSkewMs) {
      throw new RangeError('observedAt exceeds the allowed future clock skew');
    }
    if (snapshot.observedAt < activeSince(preflightNow, this.config.driftWindowMs)) {
      return emptyReceipt('stale', snapshot, requestedWeight);
    }

    let principal: VerifiedPrincipal | null;
    try {
      principal = await this.#verifier(update.principalProof, snapshot);
      if (principal) assertVerifiedPrincipal(principal);
    } catch {
      return emptyReceipt('verification-failed', snapshot, requestedWeight);
    }
    if (!principal) return emptyReceipt('verification-failed', snapshot, requestedWeight);

    const principalHash = digestOpaque('principal', principal.principalId, this.#identityHashKey);
    const trustDomainHash = digestOpaque('trust-domain', principal.trustDomain, this.#identityHashKey);
    const idempotencyDigest = digestOpaque(
      'idempotency',
      `${principalHash}\0${snapshot.idempotencyKey}`,
      this.#identityHashKey,
    );
    const embedding = normalized(snapshot.embedding, this.config.similarity);

    return this.#exclusive(() => this.storage.atomicMutate(
      snapshot.centroidId,
      async (current, recordCount) => {
      const now = this.#clock();
      assertTimestamp('clock()', now);
      const admissionBucketEnd = bucketStart(now, this.config.bucketSizeMs) + this.config.bucketSizeMs;
      if (!Number.isSafeInteger(admissionBucketEnd)) {
        throw new RangeError('clock() cannot be represented within the configured bucket size');
      }
      if (snapshot.observedAt > now + this.config.maxFutureSkewMs) {
        throw new RangeError('observedAt exceeds the allowed future clock skew');
      }
      if (snapshot.observedAt < activeSince(now, this.config.driftWindowMs)) {
        return { result: emptyReceipt('stale', snapshot, requestedWeight) };
      }
      let record = current;
      if (record) record = pruneRecord(record, now, this.config);
      if (!record) {
        if (recordCount >= this.config.maxCentroids) throw new RangeError('field has reached maxCentroids');
        record = {
          id: snapshot.centroidId,
          searchable: false,
          vector: Array.from({ length: this.config.dimension }, () => 0),
          embeddingBuckets: [],
          heads: [],
          principalInfluence: [],
          trustDomainInfluence: [],
          idempotency: [],
          createdAt: Math.min(snapshot.observedAt, now),
          updatedAt: Math.max(snapshot.observedAt, now),
          revision: 0,
        };
      }

      if (record.idempotency.some((marker) => marker.digest === idempotencyDigest)) {
        return { result: {
          ...emptyReceipt('duplicate', snapshot, requestedWeight),
            contributionClamped: false,
            revision: record.revision,
          } };
      }

      let head = record.heads.find((candidate) => candidate.configurationId === snapshot.configurationId);
      if (!head && record.heads.length >= this.config.maxConfigurationsPerCentroid) {
        throw new RangeError('centroid has reached maxConfigurationsPerCentroid');
      }

      const influenceSince = activeSince(now, this.config.influenceWindowMs);
      const principalLedger = record.principalInfluence.find((ledger) => ledger.subjectHash === principalHash);
      const domainLedger = record.trustDomainInfluence.find((ledger) => ledger.subjectHash === trustDomainHash);
      if (
        record.idempotency.length >= this.config.maxIdempotencyMarkersPerCentroid
        || (!principalLedger && record.principalInfluence.length >= this.config.maxSubjectsPerCentroid)
        || (!domainLedger && record.trustDomainInfluence.length >= this.config.maxSubjectsPerCentroid)
      ) {
        return { result: { ...emptyReceipt('cardinality-cap', snapshot, requestedWeight), revision: record.revision } };
      }
      // Keep remaining budgets unrounded. Rounding a half-quantum upward here
      // could admit a full 1e-12 contribution beyond a non-grid policy cap.
      const principalRemaining = this.config.principalInfluenceCap
        - sumActiveInfluence(principalLedger, influenceSince);
      const domainRemaining = this.config.trustDomainInfluenceCap
        - sumActiveInfluence(domainLedger, influenceSince);
      const aggregateRemaining = this.config.maxAggregateWeight
        - totalEmbeddingWeight(record, activeSince(now, this.config.driftWindowMs));

      if (principalRemaining < MIN_CONTRIBUTION_WEIGHT) {
        return { result: { ...emptyReceipt('principal-cap', snapshot, requestedWeight), revision: record.revision } };
      }
      if (domainRemaining < MIN_CONTRIBUTION_WEIGHT) {
        return { result: { ...emptyReceipt('trust-domain-cap', snapshot, requestedWeight), revision: record.revision } };
      }
      if (aggregateRemaining < MIN_CONTRIBUTION_WEIGHT) {
        return { result: { ...emptyReceipt('aggregate-cap', snapshot, requestedWeight), revision: record.revision } };
      }

      const acceptedWeight = floorWeight(Math.min(
        requestedWeight,
        this.config.maxContributionWeight,
        principalRemaining,
        domainRemaining,
        aggregateRemaining,
      ));
      if (acceptedWeight <= Number.EPSILON) {
        return { result: { ...emptyReceipt('aggregate-cap', snapshot, requestedWeight), revision: record.revision } };
      }

      const outcomeStart = bucketStart(snapshot.observedAt, this.config.bucketSizeMs);
      const admissionStart = bucketStart(now, this.config.bucketSizeMs);
      if (!head) {
        head = {
          configurationId: snapshot.configurationId,
          lastUpdatedAt: snapshot.observedAt,
          embeddingBuckets: [],
          buckets: [],
        };
        record.heads.push(head);
      }
      const headEmbeddingBucket = addToBucket(head.embeddingBuckets, outcomeStart, () => ({
        start: outcomeStart,
        lastUpdatedAt: snapshot.observedAt,
        weight: 0,
        weightedSum: Array.from({ length: this.config.dimension }, () => 0),
      }));
      headEmbeddingBucket.lastUpdatedAt = Math.max(headEmbeddingBucket.lastUpdatedAt, snapshot.observedAt);
      headEmbeddingBucket.weight = round(headEmbeddingBucket.weight + acceptedWeight);
      for (let index = 0; index < this.config.dimension; index += 1) {
        headEmbeddingBucket.weightedSum[index] = addFinite(
          headEmbeddingBucket.weightedSum[index],
          embedding[index] * acceptedWeight,
          'head embedding aggregation',
        );
      }
      const rewardBucket = addToBucket(head.buckets, outcomeStart, () => ({
        start: outcomeStart,
        lastUpdatedAt: snapshot.observedAt,
        weight: 0,
        rewardSum: 0,
        costSum: 0,
        updates: 0,
        principalHashes: [],
        trustDomainHashes: [],
      }));
      rewardBucket.lastUpdatedAt = Math.max(rewardBucket.lastUpdatedAt, snapshot.observedAt);
      rewardBucket.weight = round(rewardBucket.weight + acceptedWeight);
      rewardBucket.rewardSum = round(rewardBucket.rewardSum + snapshot.reward * acceptedWeight);
      rewardBucket.costSum = round(rewardBucket.costSum + snapshot.cost * acceptedWeight);
      rewardBucket.updates += 1;
      rewardBucket.principalHashes = sortUnique([...rewardBucket.principalHashes, principalHash]);
      rewardBucket.trustDomainHashes = sortUnique([...rewardBucket.trustDomainHashes, trustDomainHash]);
      head.lastUpdatedAt = Math.max(head.lastUpdatedAt, snapshot.observedAt);

      const updateInfluence = (ledgers: InfluenceLedger[], subjectHash: string): void => {
        let ledger = ledgers.find((candidate) => candidate.subjectHash === subjectHash);
        if (!ledger) {
          ledger = { subjectHash, buckets: [] };
          ledgers.push(ledger);
        }
        const bucket = addToBucket(ledger.buckets, admissionStart, () => ({
          start: admissionStart,
          lastUpdatedAt: now,
          weight: 0,
        }));
        bucket.lastUpdatedAt = Math.max(bucket.lastUpdatedAt, now);
        bucket.weight = round(bucket.weight + acceptedWeight);
      };
      updateInfluence(record.principalInfluence, principalHash);
      updateInfluence(record.trustDomainInfluence, trustDomainHash);
      record.idempotency.push({ digest: idempotencyDigest, observedAt: now });
      record.createdAt = Math.min(record.createdAt, snapshot.observedAt, now);
      record.updatedAt = Math.max(record.updatedAt, snapshot.observedAt, now);
      record.revision += 1;
      rebuildPublishedEmbedding(record, now, this.config);
      const metrics = metricsForHead(head, now, this.config);
      const routable = metrics.eligible && record.searchable;
      record = sortRecord(record);
      return {
        record,
        result: {
          status: routable ? 'accepted' : 'privacy-buffered',
          centroidId: snapshot.centroidId,
          configurationId: snapshot.configurationId,
          acceptedWeight,
          requestedWeight,
          contributionClamped: acceptedWeight < requestedWeight,
          support: metrics.principals.size,
          trustDomains: metrics.trustDomains.size,
          eligible: routable,
          revision: record.revision,
        },
      };
    }));
  }

  async choose(input: FieldChoiceInput): Promise<FieldChoice | null> {
    const embedding = Object.freeze([...input.embedding]);
    const requestedNow = input.now;
    const requestedLimit = input.retrievalK;
    const allowedIds = input.allowedConfigurations === undefined
      ? undefined
      : Object.freeze([...input.allowedConfigurations]);
    const previous = input.previous === undefined
      ? undefined
      : Object.freeze({
        configurationId: input.previous.configurationId,
        queryEmbedding: Object.freeze([...input.previous.queryEmbedding]),
      });
    assertVector(embedding, this.config.dimension);
    const query = normalized(embedding, this.config.similarity);
    const limit = requestedLimit ?? this.config.retrievalK;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('retrievalK must be an integer in [1, 10000]');
    }
    const allowed = allowedIds
      ? new Set(allowedIds.map((id) => (assertIdentifier('allowed configuration', id), id)))
      : null;
    if (previous) {
      assertIdentifier('previous configurationId', previous.configurationId);
      assertVector(previous.queryEmbedding, this.config.dimension, 'previous queryEmbedding');
    }
    await this.#mutationTail;
    const trustedNow = this.#clock();
    assertTimestamp('clock()', trustedNow);
    const now = requestedNow ?? trustedNow;
    assertTimestamp('now', now);
    if (
      now > trustedNow + this.config.maxFutureSkewMs
      || now < activeSince(trustedNow, this.config.driftWindowMs)
    ) {
      throw new RangeError('query now falls outside the trusted clock window');
    }
    // Expire stale centroids before ANN top-K. Filtering after search is too
    // late: an expired high-similarity centroid could occupy K and censor an
    // active lower-similarity centroid.
    await this.compact({ now: trustedNow });

    // Native indexes can temporarily expose duplicate IDs after an upsert. One
    // centroid is atomic here, so keep only its highest-scoring occurrence.
    const deduplicated = new Map<string, Awaited<ReturnType<FieldStorageAdapter['search']>>[number]>();
    for (const hit of await this.storage.search(query, limit)) {
      if (!Number.isFinite(hit.similarity) || hit.similarity < -1 || hit.similarity > 1) {
        throw new Error('storage adapter returned similarity outside [-1, 1]');
      }
      const previous = deduplicated.get(hit.record.id);
      if (!previous || hit.similarity > previous.similarity) deduplicated.set(hit.record.id, hit);
    }
    const hits = [...deduplicated.values()]
      .filter((hit) => hit.similarity >= this.config.minimumSimilarity)
      .sort((a, b) => b.similarity - a.similarity || compareText(a.record.id, b.record.id));

    const accumulators = new Map<string, CandidateAccumulator>();
    for (const hit of hits) {
      for (const head of hit.record.heads) {
        if (allowed && !allowed.has(head.configurationId)) continue;
        const metrics = metricsForHead(head, now, this.config);
        if (!metrics.eligible) continue;
        const normalizedAffinity = this.config.minimumSimilarity === 1
          ? 1
          : Math.max(0, (hit.similarity - this.config.minimumSimilarity) / (1 - this.config.minimumSimilarity));
        const affinity = Math.max(Number.EPSILON, normalizedAffinity * Math.log1p(metrics.effectiveWeight));
        const score = round(
          this.config.semanticWeight * hit.similarity
          + metrics.rewardScore
          - this.config.costPenaltyWeight * (metrics.costScore / this.config.costScale),
        );
        let accumulator = accumulators.get(head.configurationId);
        if (!accumulator) {
          accumulator = {
            configurationId: head.configurationId,
            weightedScore: 0,
            weightedReward: 0,
            weightedMeanCost: 0,
            totalAffinity: 0,
            effectiveWeight: 0,
            bestSimilarity: -1,
            principals: new Set(),
            trustDomains: new Set(),
            centroidIds: new Set(),
          };
          accumulators.set(head.configurationId, accumulator);
        }
        accumulator.weightedScore += score * affinity;
        accumulator.weightedReward += metrics.rewardScore * affinity;
        accumulator.weightedMeanCost += metrics.meanCost * affinity;
        accumulator.totalAffinity += affinity;
        accumulator.effectiveWeight += metrics.effectiveWeight;
        accumulator.bestSimilarity = Math.max(accumulator.bestSimilarity, hit.similarity);
        for (const value of metrics.principals) accumulator.principals.add(value);
        for (const value of metrics.trustDomains) accumulator.trustDomains.add(value);
        accumulator.centroidIds.add(hit.record.id);
      }
    }

    const candidates: FieldChoiceCandidate[] = [...accumulators.values()]
      .map((candidate) => ({
        configurationId: candidate.configurationId,
        score: round(candidate.weightedScore / candidate.totalAffinity),
        rewardScore: round(candidate.weightedReward / candidate.totalAffinity),
        meanCost: round(candidate.weightedMeanCost / candidate.totalAffinity),
        effectiveWeight: round(candidate.effectiveWeight),
        bestSimilarity: round(candidate.bestSimilarity),
        support: candidate.principals.size,
        trustDomains: candidate.trustDomains.size,
        centroidIds: [...candidate.centroidIds].sort(compareText),
      }))
      .sort((a, b) => b.score - a.score || compareText(a.configurationId, b.configurationId));
    if (candidates.length === 0) return null;

    let selected = candidates[0];
    let hysteresisApplied = false;
    let semanticContinuity: number | null = null;
    if (previous) {
      semanticContinuity = round(cosine(query, normalized(previous.queryEmbedding, this.config.similarity)));
      if (
        this.config.hysteresisMargin > 0
        && semanticContinuity >= this.config.semanticContinuityThreshold
      ) {
        const prior = candidates.find((candidate) => candidate.configurationId === previous.configurationId);
        if (prior && prior.configurationId !== selected.configurationId) {
          const deficit = selected.score - prior.score;
          if (deficit <= this.config.hysteresisMargin) {
            selected = prior;
            hysteresisApplied = true;
          }
        }
      }
    }

    return {
      configurationId: selected.configurationId,
      score: selected.score,
      hysteresisApplied,
      semanticContinuity,
      searchedCentroids: hits.length,
      candidates,
    };
  }

  async compact(options: CompactOptions): Promise<CompactResult> {
    assertTimestamp('compact now', options.now);
    return this.#exclusive(async () => {
      const records = await this.storage.list();
      const result: CompactResult = {
        inspected: records.length,
        changed: 0,
        removedCentroids: 0,
        removedHeads: 0,
        removedBuckets: 0,
      };
      for (const snapshot of records.sort((a, b) => compareText(a.id, b.id))) {
        const delta = await this.storage.atomicMutate(snapshot.id, async (current) => {
          if (!current) return { result: { changed: 0, removedCentroids: 0, removedHeads: 0, removedBuckets: 0 } };
          const compacted = pruneRecord(current, options.now, this.config);
          const removedHeads = current.heads.length - compacted.heads.length;
          const removedBuckets = countBuckets(current) - countBuckets(compacted);
          if (
            compacted.heads.length === 0
            && compacted.principalInfluence.length === 0
            && compacted.trustDomainInfluence.length === 0
            && compacted.idempotency.length === 0
          ) {
            return {
              record: null,
              result: { changed: 1, removedCentroids: 1, removedHeads, removedBuckets },
            };
          }
          if (canonicalJson(current) === canonicalJson(compacted)) {
            return { result: { changed: 0, removedCentroids: 0, removedHeads, removedBuckets } };
          }
          compacted.revision = current.revision + 1;
          compacted.updatedAt = Math.max(current.updatedAt, options.now);
          return {
            record: sortRecord(compacted),
            result: { changed: 1, removedCentroids: 0, removedHeads, removedBuckets },
          };
        });
        result.changed += delta.changed;
        result.removedCentroids += delta.removedCentroids;
        result.removedHeads += delta.removedHeads;
        result.removedBuckets += delta.removedBuckets;
      }
      return result;
    });
  }

  async exportState(): Promise<FieldMemoryState> {
    await this.#mutationTail;
    const payload: FieldMemoryStatePayload = {
      schemaVersion: FIELD_MEMORY_SCHEMA_VERSION,
      identityKeyId: this.#identityKeyId,
      policy: clone(this.config),
      records: (await this.storage.list()).map(sortRecord).sort((a, b) => compareText(a.id, b.id)),
    };
    const state: FieldMemoryState = {
      ...payload,
      integrity: { algorithm: 'hmac-sha256', digest: hmacSha256(canonicalJson(payload), this.#identityHashKey) },
    };
    countScalars(state);
    if (Buffer.byteLength(canonicalJson(state), 'utf8') > MAX_IMPORT_BYTES) {
      throw new RangeError('state exceeds the reversible 16 MiB snapshot limit');
    }
    return state;
  }

  async exportStateJson(): Promise<string> {
    return canonicalJson(await this.exportState());
  }

  async importState(input: string | FieldMemoryState, options: ImportStateOptions = {}): Promise<void> {
    if ((options.mode ?? 'replace') !== 'replace') throw new TypeError('only replace import mode is supported');
    if (!this.storage.atomicReplace) {
      throw new Error('state import requires an adapter with atomicReplace=true');
    }
    let raw: unknown;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > MAX_IMPORT_BYTES) throw new RangeError('state exceeds 16 MiB import limit');
      raw = JSON.parse(input) as unknown;
    } else {
      countScalars(input);
      raw = input;
    }
    if (!isRecordObject(raw)) throw new TypeError('invalid field-memory state');
    exactKeys(raw, ['schemaVersion', 'identityKeyId', 'policy', 'records', 'integrity'], 'field-memory state');
    if (raw.schemaVersion !== FIELD_MEMORY_SCHEMA_VERSION) throw new Error('unsupported field-memory schema version');
    if (typeof raw.identityKeyId !== 'string' || !secureHexEqual(raw.identityKeyId, this.#identityKeyId)) {
      throw new Error('field-memory identity key does not match state');
    }
    if (!isRecordObject(raw.integrity) || raw.integrity.algorithm !== 'hmac-sha256' || typeof raw.integrity.digest !== 'string') {
      throw new TypeError('invalid field-memory state integrity');
    }
    exactKeys(raw.integrity, ['algorithm', 'digest'], 'state integrity');
    if (!HASH.test(raw.integrity.digest)) throw new TypeError('invalid state integrity digest');
    if (!isRecordObject(raw.policy) || !Array.isArray(raw.records)) throw new TypeError('invalid field-memory state payload');
    const rawPolicy: Record<string, unknown> = raw.policy;
    exactKeys(rawPolicy, Object.keys(this.config), 'state policy');
    if (Object.entries(this.config).some(([key, value]) => rawPolicy[key] !== value)) {
      throw new Error('field-memory state policy does not match the active policy');
    }
    if (raw.records.length > this.config.maxCentroids) throw new RangeError('state exceeds maxCentroids');
    const budget: ImportBudget = { remaining: MAX_IMPORT_SCALARS };
    consume(budget, raw.records.length);
    const records = raw.records.map((record) => parseRecord(record, this.config, budget));
    const ids = new Set(records.map((record) => record.id));
    if (ids.size !== records.length) throw new Error('state contains duplicate centroid IDs');
    records.sort((a, b) => compareText(a.id, b.id));
    const payload: FieldMemoryStatePayload = {
      schemaVersion: FIELD_MEMORY_SCHEMA_VERSION,
      identityKeyId: this.#identityKeyId,
      policy: clone(this.config),
      records,
    };
    const canonicalPayload = canonicalJson(payload);
    if (Buffer.byteLength(canonicalPayload, 'utf8') > MAX_IMPORT_BYTES) {
      throw new RangeError('state exceeds effective import size limit');
    }
    const expected = hmacSha256(canonicalPayload, this.#identityHashKey);
    if (!secureHexEqual(raw.integrity.digest, expected)) throw new Error('field-memory state integrity check failed');
    await this.#exclusive(() => this.storage.replaceAll(records));
  }
}

export function createFieldMemory<Proof = unknown>(options: FieldMemoryOptions<Proof>): FieldMemory<Proof> {
  return new FieldMemory(options);
}
