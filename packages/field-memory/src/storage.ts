import type {
  FieldStorageAdapter,
  PackedCentroidRecord,
  StorageSearchHit,
  VectorMetric,
} from './types.js';
import { assertIdentifier, assertVector, clone, compareText, similarity } from './util.js';

/** Dependency-free reference adapter and deterministic test oracle. */
export class InMemoryFieldStorage implements FieldStorageAdapter {
  readonly atomicReplace = true;
  readonly writerScope = 'process' as const;
  readonly dimension: number;
  readonly metric: VectorMetric;
  readonly #records = new Map<string, PackedCentroidRecord>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { dimension: number; metric?: VectorMetric } = { dimension: 384 }) {
    if (!Number.isInteger(options.dimension) || options.dimension < 1) {
      throw new RangeError('storage dimension must be a positive integer');
    }
    this.dimension = options.dimension;
    this.metric = options.metric ?? 'cosine';
  }

  async search(vector: readonly number[], limit: number): Promise<StorageSearchHit[]> {
    await this.#tail;
    assertVector(vector, this.dimension, 'query vector');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('search limit must be a positive integer');
    return [...this.#records.values()]
      .filter((record) => record.searchable)
      .map((record) => ({ record, similarity: similarity(vector, record.vector, this.metric) }))
      .sort((a, b) => b.similarity - a.similarity || compareText(a.record.id, b.record.id))
      .slice(0, limit)
      .map(clone);
  }

  async get(id: string): Promise<PackedCentroidRecord | null> {
    await this.#tail;
    assertIdentifier('centroid id', id);
    const record = this.#records.get(id);
    return record ? clone(record) : null;
  }

  async list(): Promise<PackedCentroidRecord[]> {
    await this.#tail;
    return [...this.#records.values()]
      .sort((a, b) => compareText(a.id, b.id))
      .map(clone);
  }

  async upsert(record: PackedCentroidRecord): Promise<void> {
    await this.atomicMutate(record.id, async () => ({ record, result: undefined }));
  }

  async delete(id: string): Promise<boolean> {
    return this.atomicMutate(id, async (current) => ({ record: null, result: current !== null }));
  }

  async replaceAll(records: readonly PackedCentroidRecord[]): Promise<void> {
    await this.#exclusive(async () => {
      const next = new Map<string, PackedCentroidRecord>();
      for (const record of records) {
        assertIdentifier('centroid id', record.id);
        assertVector(record.vector, this.dimension, 'centroid vector');
        if (next.has(record.id)) throw new Error(`duplicate centroid id in replaceAll: ${record.id}`);
        next.set(record.id, clone(record));
      }
      this.#records.clear();
      for (const [id, record] of next) this.#records.set(id, record);
    });
  }

  async atomicMutate<Result>(
    id: string,
    mutation: (
      current: PackedCentroidRecord | null,
      recordCount: number,
    ) => Promise<{ record?: PackedCentroidRecord | null; result: Result }>,
  ): Promise<Result> {
    assertIdentifier('centroid id', id);
    return this.#exclusive(async () => {
      const current = this.#records.get(id);
      const decision = await mutation(current ? clone(current) : null, this.#records.size);
      if (decision.record !== undefined) {
        if (decision.record === null) {
          this.#records.delete(id);
        } else {
          if (decision.record.id !== id) throw new Error('atomicMutate cannot change the centroid ID');
          assertVector(decision.record.vector, this.dimension, 'centroid vector');
          this.#records.set(id, clone(decision.record));
        }
      }
      return decision.result;
    });
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Aggregate index cardinality only; no record or episode inspection. */
  stats(): { entries: number; records: number } {
    return {
      entries: [...this.#records.values()].filter((record) => record.searchable).length,
      records: this.#records.size,
    };
  }
}
