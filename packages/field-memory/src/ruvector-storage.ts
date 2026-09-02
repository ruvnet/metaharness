import { isAbsolute, resolve } from 'node:path';
import type {
  FieldStorageAdapter,
  PackedCentroidRecord,
  RuVectorFieldStorageOptions,
  RuVectorRecordRegistry,
  StorageSearchHit,
  VectorMetric,
} from './types.js';
import { assertIdentifier, assertVector, clone, compareText } from './util.js';

const METADATA_KEY = 'metaharnessFieldMemory';

export class InMemoryRuVectorRecordRegistry implements RuVectorRecordRegistry {
  readonly writerScope = 'process' as const;
  readonly #records = new Map<string, PackedCentroidRecord>();
  #tail: Promise<void> = Promise.resolve();

  constructor(records: readonly PackedCentroidRecord[] = []) {
    for (const record of records) this.#records.set(record.id, clone(record));
  }

  withLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async get(id: string): Promise<PackedCentroidRecord | null> {
    const record = this.#records.get(id);
    return record ? clone(record) : null;
  }

  async list(): Promise<PackedCentroidRecord[]> {
    return [...this.#records.values()]
      .sort((a, b) => compareText(a.id, b.id))
      .map(clone);
  }

  async count(): Promise<number> {
    return this.#records.size;
  }

  async upsert(record: PackedCentroidRecord): Promise<void> {
    this.#records.set(record.id, clone(record));
  }

  async delete(id: string): Promise<boolean> {
    return this.#records.delete(id);
  }
}

function toSimilarity(score: number): number {
  if (!Number.isFinite(score)) throw new Error('RuVector returned a non-finite score');
  if (score < 0 || score > 2) throw new Error('RuVector returned cosine distance outside [0, 2]');
  return 1 - score;
}

class RuVectorFieldStorage implements FieldStorageAdapter {
  readonly dimension: number;
  readonly metric: VectorMetric;
  readonly atomicReplace: boolean;
  readonly writerScope: 'process' | 'distributed';
  readonly #options: RuVectorFieldStorageOptions;
  readonly #registry: RuVectorRecordRegistry;
  readonly #searchOversample: number;

  constructor(options: RuVectorFieldStorageOptions) {
    if (!isAbsolute(options.storagePath)) {
      throw new TypeError('RuVector storagePath must be absolute');
    }
    if (!Number.isInteger(options.dimension) || options.dimension < 1) {
      throw new RangeError('RuVector adapter dimension must be a positive integer');
    }
    this.dimension = options.dimension;
    if (options.metric !== undefined && options.metric !== 'cosine') {
      throw new TypeError('RuVector field storage v0.1 supports only the cosine metric');
    }
    if ('scoreKind' in options) {
      throw new TypeError('RuVector field storage does not accept caller-defined score semantics');
    }
    this.metric = 'cosine';
    if (typeof options.db.getIndexInfo !== 'function') {
      throw new TypeError('RuVector field storage requires getIndexInfo() from RuVector PR #831 or later');
    }
    const indexInfo = options.db.getIndexInfo();
    if (
      options.db.indexType !== 'flat'
      || indexInfo.indexType !== 'flat'
      || indexInfo.mutationMode !== 'in-place'
      || indexInfo.configurationVerified !== true
    ) {
      throw new Error("RuVector field storage requires a configuration-verified flat, in-place index (RuVector PR #831 or later)");
    }
    if (indexInfo.dimensions !== this.dimension) {
      throw new Error(`RuVector database dimension ${indexInfo.dimensions} does not match adapter ${this.dimension}`);
    }
    if (indexInfo.distanceMetric !== this.metric) {
      throw new Error(`RuVector database metric ${indexInfo.distanceMetric} does not match adapter ${this.metric}`);
    }
    if (!isAbsolute(indexInfo.storagePath) || resolve(indexInfo.storagePath) !== resolve(options.storagePath)) {
      throw new Error('RuVector database storagePath does not match the adapter storage identity');
    }
    this.#searchOversample = options.searchOversample ?? 4;
    if (!Number.isInteger(this.#searchOversample) || this.#searchOversample < 1 || this.#searchOversample > 32) {
      throw new RangeError('searchOversample must be an integer in [1, 32]');
    }
    this.#options = options;
    if (!options.registry) {
      throw new TypeError('RuVector adapter requires an explicit record registry');
    }
    if (!['process', 'distributed'].includes(options.registry.writerScope)) {
      throw new TypeError('RuVector registry writerScope must be process or distributed');
    }
    for (const method of ['withLock', 'get', 'count', 'list', 'upsert', 'delete'] as const) {
      if (typeof options.registry[method] !== 'function') {
        throw new TypeError(`RuVector registry must implement ${method}()`);
      }
    }
    this.#registry = options.registry;
    this.atomicReplace = typeof options.replaceAllAtomically === 'function';
    this.writerScope = this.#registry.writerScope;
  }

  async search(vector: readonly number[], limit: number): Promise<StorageSearchHit[]> {
    assertVector(vector, this.dimension, 'RuVector query vector');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('search limit must be a positive integer');
    return this.#registry.withLock(async () => {
      const indexSize = await this.#options.db.len();
      if (indexSize === 0) return [];
      const best = new Map<string, StorageSearchHit>();
      const nativeLimit = Math.min(indexSize, limit * this.#searchOversample);
      const matches = await this.#options.db.search({ vector: [...vector], k: nativeLimit });
      for (const match of matches) {
        assertIdentifier('RuVector result id', match.id);
        const record = await this.#registry.get(match.id);
        if (!record?.searchable) continue;
        const fieldMetadata = match.metadata?.[METADATA_KEY];
        if (
          typeof fieldMetadata !== 'object'
          || fieldMetadata === null
          || Array.isArray(fieldMetadata)
          || (fieldMetadata as Record<string, unknown>).schemaVersion !== 'metaharness.field-memory/v1'
          || (fieldMetadata as Record<string, unknown>).revision !== record.revision
        ) {
          // A crash can split the native upsert and registry transaction. Do
          // not pair a vector from one revision with aggregates from another.
          continue;
        }
        const candidate = {
          record,
          similarity: toSimilarity(match.score),
        };
        const existing = best.get(record.id);
        if (!existing || candidate.similarity > existing.similarity) best.set(record.id, candidate);
      }
      return [...best.values()]
        .sort((a, b) => b.similarity - a.similarity || compareText(a.record.id, b.record.id))
        .slice(0, limit)
        .map(clone);
    });
  }

  async get(id: string): Promise<PackedCentroidRecord | null> {
    assertIdentifier('centroid id', id);
    return this.#registry.withLock(() => this.#registry.get(id));
  }

  async list(): Promise<PackedCentroidRecord[]> {
    return this.#registry.withLock(async () =>
      (await this.#registry.list()).sort((a, b) => compareText(a.id, b.id)));
  }

  async upsert(record: PackedCentroidRecord): Promise<void> {
    await this.atomicMutate(record.id, async () => ({ record, result: undefined }));
  }

  async delete(id: string): Promise<boolean> {
    return this.atomicMutate(id, async (current) => ({ record: null, result: current !== null }));
  }

  async replaceAll(records: readonly PackedCentroidRecord[]): Promise<void> {
    if (!this.#options.replaceAllAtomically) {
      throw new Error('RuVector adapter has no atomic index+registry replacement transaction');
    }
    await this.#registry.withLock(() => this.#options.replaceAllAtomically!(records.map(clone)));
  }

  async atomicMutate<Result>(
    id: string,
    mutation: (
      current: PackedCentroidRecord | null,
      recordCount: number,
    ) => Promise<{ record?: PackedCentroidRecord | null; result: Result }>,
  ): Promise<Result> {
    assertIdentifier('centroid id', id);
    return this.#registry.withLock(async () => {
      const current = await this.#registry.get(id);
      const count = await this.#registry.count();
      const decision = await mutation(current, count);
      if (decision.record === undefined) return decision.result;
      if (decision.record === null) {
        await this.#deleteUnderLock(current, id);
        return decision.result;
      }
      if (decision.record.id !== id) throw new Error('atomicMutate cannot change the centroid ID');
      assertVector(decision.record.vector, this.dimension, 'centroid vector');
      await this.#replaceUnderLock(current, decision.record);
      return decision.result;
    });
  }

  async #replaceUnderLock(
    current: PackedCentroidRecord | null,
    next: PackedCentroidRecord,
  ): Promise<void> {
    try {
      if (next.searchable) await this.#insertNative(next);
      else if (current?.searchable) await this.#options.db.delete(next.id);
      await this.#registry.upsert(next);
    } catch (error) {
      try {
        if (current?.searchable) await this.#insertNative(current);
        else await this.#options.db.delete(next.id);
        if (current) await this.#registry.upsert(current);
        else await this.#registry.delete(next.id);
      } catch (rollbackError) {
        await this.#registry.delete(next.id);
        throw new AggregateError([error, rollbackError], 'RuVector mutation and rollback both failed');
      }
      throw error;
    }
  }

  async #deleteUnderLock(current: PackedCentroidRecord | null, id: string): Promise<void> {
    try {
      if (current?.searchable) await this.#options.db.delete(id);
      await this.#registry.delete(id);
    } catch (error) {
      try {
        if (current?.searchable) await this.#insertNative(current);
        if (current) await this.#registry.upsert(current);
      } catch (rollbackError) {
        await this.#registry.delete(id).catch(() => false);
        throw new AggregateError([error, rollbackError], 'RuVector deletion and rollback both failed');
      }
      throw error;
    }
  }

  async #insertNative(record: PackedCentroidRecord): Promise<void> {
    const insertedId = await this.#options.db.insert({
      id: record.id,
      vector: [...record.vector],
      metadata: {
        [METADATA_KEY]: {
          schemaVersion: 'metaharness.field-memory/v1',
          revision: record.revision,
        },
      },
    });
    if (insertedId !== record.id) throw new Error('RuVector changed the requested centroid ID');
  }
}

/** Wrap an already-open, explicit-path ruvector.VectorDb without importing it. */
export function createRuVectorFieldStorage(options: RuVectorFieldStorageOptions): FieldStorageAdapter {
  return new RuVectorFieldStorage(options);
}
