/** Current portable state format. Import rejects unknown schema versions. */
export const FIELD_MEMORY_SCHEMA_VERSION = 'metaharness.field-memory/v1' as const;

export type FieldMemorySchemaVersion = typeof FIELD_MEMORY_SCHEMA_VERSION;
export type VectorMetric = 'cosine' | 'dot' | 'euclidean';

/**
 * Policy values that change routing, privacy, or influence semantics.
 * They are persisted with exported state so imports cannot silently reinterpret
 * an attractor field under a different policy.
 */
export interface FieldMemoryConfig {
  dimension: number;
  similarity?: VectorMetric;
  retrievalK?: number;
  minimumSimilarity?: number;
  minimumSupport?: number;
  minimumTrustDomains?: number;
  decayHalfLifeMs?: number;
  driftWindowMs?: number;
  bucketSizeMs?: number;
  influenceWindowMs?: number;
  idempotencyWindowMs?: number;
  maxContributionWeight?: number;
  principalInfluenceCap?: number;
  trustDomainInfluenceCap?: number;
  maxAggregateWeight?: number;
  maxRecordedCost?: number;
  maxVectorMagnitude?: number;
  maxConfigurationsPerCentroid?: number;
  maxCentroids?: number;
  maxSubjectsPerCentroid?: number;
  maxIdempotencyMarkersPerCentroid?: number;
  costPenaltyWeight?: number;
  costScale?: number;
  priorWeight?: number;
  semanticWeight?: number;
  hysteresisMargin?: number;
  semanticContinuityThreshold?: number;
  maxFutureSkewMs?: number;
}

export interface ResolvedFieldMemoryConfig {
  dimension: number;
  similarity: VectorMetric;
  retrievalK: number;
  minimumSimilarity: number;
  minimumSupport: number;
  minimumTrustDomains: number;
  decayHalfLifeMs: number;
  driftWindowMs: number;
  bucketSizeMs: number;
  influenceWindowMs: number;
  idempotencyWindowMs: number;
  maxContributionWeight: number;
  principalInfluenceCap: number;
  trustDomainInfluenceCap: number;
  maxAggregateWeight: number;
  maxRecordedCost: number;
  maxVectorMagnitude: number;
  maxConfigurationsPerCentroid: number;
  maxCentroids: number;
  maxSubjectsPerCentroid: number;
  maxIdempotencyMarkersPerCentroid: number;
  costPenaltyWeight: number;
  costScale: number;
  priorWeight: number;
  semanticWeight: number;
  hysteresisMargin: number;
  semanticContinuityThreshold: number;
  maxFutureSkewMs: number;
}

/** The update fields a verifier is allowed to authorize. The proof is separate. */
export interface VerifiableFieldUpdate {
  centroidId: string;
  embedding: readonly number[];
  configurationId: string;
  reward: number;
  cost: number;
  observedAt: number;
  idempotencyKey: string;
  weight?: number;
}

/** A verifier-owned proof. It is never persisted or returned. */
export interface FieldUpdate<Proof = unknown> extends VerifiableFieldUpdate {
  principalProof: Proof;
}

/**
 * Only values returned by the verifier are used for influence accounting.
 * principalId should be a stable, high-entropy, deployment-scoped identifier.
 */
export interface VerifiedPrincipal {
  principalId: string;
  trustDomain: string;
}

export type PrincipalVerifier<Proof = unknown> = (
  proof: Proof,
  update: Readonly<VerifiableFieldUpdate>,
) => VerifiedPrincipal | null | Promise<VerifiedPrincipal | null>;

export interface FieldMemoryOptions<Proof = unknown> {
  config: FieldMemoryConfig;
  verifier: PrincipalVerifier<Proof>;
  /** At least 32 bytes; never persisted. Reuse the same key after state restore. */
  identityHashKey: string | Uint8Array;
  storage?: FieldStorageAdapter;
  clock?: () => number;
}

export type UpdateStatus =
  | 'accepted'
  | 'privacy-buffered'
  | 'duplicate'
  | 'verification-failed'
  | 'principal-cap'
  | 'trust-domain-cap'
  | 'aggregate-cap'
  | 'cardinality-cap'
  | 'stale';

export interface UpdateReceipt {
  status: UpdateStatus;
  centroidId: string;
  configurationId: string;
  acceptedWeight: number;
  requestedWeight: number;
  contributionClamped: boolean;
  support: number;
  trustDomains: number;
  eligible: boolean;
  revision: number | null;
}

export interface PreviousFieldChoice {
  configurationId: string;
  /** Query embedding used when the previous configuration was selected. */
  queryEmbedding: readonly number[];
}

export interface FieldChoiceInput {
  embedding: readonly number[];
  now?: number;
  allowedConfigurations?: readonly string[];
  previous?: PreviousFieldChoice;
  retrievalK?: number;
}

export interface FieldChoiceCandidate {
  configurationId: string;
  score: number;
  rewardScore: number;
  meanCost: number;
  effectiveWeight: number;
  bestSimilarity: number;
  support: number;
  trustDomains: number;
  centroidIds: string[];
}

export interface FieldChoice {
  configurationId: string;
  score: number;
  hysteresisApplied: boolean;
  semanticContinuity: number | null;
  searchedCentroids: number;
  candidates: FieldChoiceCandidate[];
}

export interface CompactOptions {
  /** Explicit time makes compaction replayable and byte-deterministic. */
  now: number;
}

export interface CompactResult {
  inspected: number;
  changed: number;
  removedCentroids: number;
  removedHeads: number;
  removedBuckets: number;
}

/** Aggregated vector contribution for one deterministic time bucket. */
export interface EmbeddingBucket {
  start: number;
  lastUpdatedAt: number;
  weight: number;
  weightedSum: number[];
}

/** Aggregated outcome data. It contains no prompt, solution, tool trace, or episode. */
export interface RewardBucket {
  start: number;
  lastUpdatedAt: number;
  weight: number;
  rewardSum: number;
  costSum: number;
  updates: number;
  principalHashes: string[];
  trustDomainHashes: string[];
}

export interface RewardHead {
  configurationId: string;
  lastUpdatedAt: number;
  /** Includes quarantined embeddings; never used for search below support. */
  embeddingBuckets: EmbeddingBucket[];
  buckets: RewardBucket[];
}

export interface InfluenceBucket {
  start: number;
  lastUpdatedAt: number;
  weight: number;
}

export interface InfluenceLedger {
  subjectHash: string;
  buckets: InfluenceBucket[];
}

export interface IdempotencyMarker {
  digest: string;
  observedAt: number;
}

/**
 * One atomic vector-index entry. All configuration reward heads live behind
 * this single centroid, preventing retrievalK from censoring configurations.
 */
export interface PackedCentroidRecord {
  id: string;
  /** False while every head is below the support gate. */
  searchable: boolean;
  vector: number[];
  /** Derived exclusively from support-eligible heads. */
  embeddingBuckets: EmbeddingBucket[];
  heads: RewardHead[];
  principalInfluence: InfluenceLedger[];
  trustDomainInfluence: InfluenceLedger[];
  idempotency: IdempotencyMarker[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface StorageSearchHit {
  record: PackedCentroidRecord;
  /** Higher is more similar. Adapters must normalize this to [-1, 1]. */
  similarity: number;
}

/**
 * Structural storage seam for RuVector or another vector index. There is no
 * native dependency. Implementations must upsert by ID, return each ID once,
 * preserve their configured metric across replaceAll, and detach returned data.
 */
export interface FieldStorageAdapter {
  readonly dimension: number;
  readonly metric: VectorMetric;
  readonly atomicReplace: boolean;
  /** Scope in which atomicMutate is guaranteed to serialize all writers. */
  readonly writerScope: 'process' | 'distributed';
  search(vector: readonly number[], limit: number): Promise<StorageSearchHit[]>;
  get(id: string): Promise<PackedCentroidRecord | null>;
  list(): Promise<PackedCentroidRecord[]>;
  upsert(record: PackedCentroidRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  replaceAll(records: readonly PackedCentroidRecord[]): Promise<void>;
  /**
   * Globally serialized read-modify-write. Implementations must lock all field
   * writers, not only this ID, so cardinality and influence caps are atomic.
   * `record: undefined` means no mutation; null means delete.
   */
  atomicMutate<Result>(
    id: string,
    mutation: (
      current: PackedCentroidRecord | null,
      recordCount: number,
    ) => Promise<{ record?: PackedCentroidRecord | null; result: Result }>,
  ): Promise<Result>;
}

export interface FieldMemoryStatePayload {
  schemaVersion: FieldMemorySchemaVersion;
  /** Non-secret HMAC fingerprint; detects restore with a different identity key. */
  identityKeyId: string;
  policy: ResolvedFieldMemoryConfig;
  records: PackedCentroidRecord[];
}

export interface FieldMemoryState extends FieldMemoryStatePayload {
  integrity: {
    algorithm: 'hmac-sha256';
    digest: string;
  };
}

export interface ImportStateOptions {
  mode?: 'replace';
}

/** Minimal duck type implemented by ruvector.VectorDb; no package import is required. */
export interface RuVectorDbLike {
  /** Runtime construction fails unless this is flat. The wider type matches VectorDb. */
  readonly indexType: 'hnsw' | 'flat';
  getIndexInfo(): {
    indexType: 'hnsw' | 'flat';
    dimensions: number;
    distanceMetric: string;
    storagePath: string;
    mutationMode: 'in-place' | 'rebuild' | 'unverified';
    /** True only when RuVector verified requested options against persisted configuration. */
    configurationVerified: boolean;
  };
  insert(entry: {
    id?: string;
    vector: Float32Array | number[];
    metadata?: Record<string, unknown>;
  }): Promise<string>;
  search(query: {
    vector: Float32Array | number[];
    k: number;
  }): Promise<Array<{
    id: string;
    score: number;
    vector?: Float32Array;
    metadata?: Record<string, unknown>;
  }>>;
  get(id: string): Promise<{ id?: string; vector: Float32Array; metadata?: Record<string, unknown> } | null>;
  delete(id: string): Promise<boolean>;
  len(): Promise<number>;
}

/** Durable implementations are required when a RuVector index survives restart. */
export interface RuVectorRecordRegistry {
  readonly writerScope: 'process' | 'distributed';
  /** Global lock shared by every adapter/process using the same field. */
  withLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  get(id: string): Promise<PackedCentroidRecord | null>;
  /** Exact cardinality inside the same transaction/lock as atomicMutate. */
  count(): Promise<number>;
  list(): Promise<PackedCentroidRecord[]>;
  upsert(record: PackedCentroidRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface RuVectorFieldStorageOptions {
  db: RuVectorDbLike;
  /** Required guard against RuVector's implicit ./ruvector.db schema collision. */
  storagePath: string;
  dimension: number;
  /** v0.1 supports RuVector's canonical cosine-distance contract only. */
  metric?: 'cosine';
  /** Explicitly choose a durable registry, or the exported process-local registry for ephemeral use. */
  registry: RuVectorRecordRegistry;
  searchOversample?: number;
  /**
   * Optional deployment transaction that swaps both the index and durable
   * registry. Without it atomicReplace=false and state import fails closed.
   */
  replaceAllAtomically?: (records: readonly PackedCentroidRecord[]) => Promise<void>;
}
