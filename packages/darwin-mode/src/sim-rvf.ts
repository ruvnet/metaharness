// SPDX-License-Identifier: MIT
// Optional native RuVector Format index for optimizer memory.
// Uses the same async RvfDatabase API as @metaharness/kernel memory-rvf.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SimVectorIndex, SimVectorHit } from './sim-memory.js';

interface RvfDb {
  ingestBatch(rows: Array<{ id: string; vector: number[] }>): Promise<{ accepted: number; rejected: number }>;
  query(vector: number[], k: number, options?: { forceExact?: boolean }): Promise<Array<{ id: string; distance: number }>>;
  dimension(): Promise<number>;
  close(): Promise<void>;
}
interface RvfStatic {
  create(path: string, opts: { dimensions: number; metric: string }): Promise<RvfDb>;
  open(path: string): Promise<RvfDb>;
}
interface RvfModule { RvfDatabase?: RvfStatic; default?: { RvfDatabase?: RvfStatic } }

/**
 * Returns null only when @ruvector/rvf is not installed.
 * Native errors, dimension drift and lock contention FAIL CLOSED.
 * The caller is responsible for a per-owner/repo index path.
 */
export async function openRvfSimIndex(path: string, dimensions: number): Promise<SimVectorIndex | null> {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    throw new Error('SIM RVF: dimensions must be in [1,8192]');
  }
  let module: RvfModule;
  try {
    // A variable import preserves the optional SDK dependency for bare Darwin users.
    const name: string = '@ruvector/rvf';
    module = await import(name) as RvfModule;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' && String(error).includes('@ruvector/rvf')) return null;
    throw error;
  }
  const Rvf = module.RvfDatabase ?? module.default?.RvfDatabase;
  if (!Rvf) throw new Error('SIM RVF: SDK lacks RvfDatabase');
  const filename = resolve(path);
  await mkdir(dirname(filename), { recursive: true });
  const db = existsSync(filename)
    ? await Rvf.open(filename)
    : await Rvf.create(filename, { dimensions, metric: 'cosine' });
  if (await db.dimension() !== dimensions) {
    await db.close();
    throw new Error('SIM RVF: dimension mismatch');
  }
  let closed = false;
  const check = (vector: number[]) => {
    if (closed) throw new Error('SIM RVF: index closed');
    if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite)) {
      throw new Error('SIM RVF: invalid vector');
    }
  };
  return {
    async upsert(id: string, vector: number[]): Promise<void> {
      if (typeof id !== 'string' || !id || id.length > 160) throw new Error('SIM RVF: invalid id');
      check(vector);
      const result = await db.ingestBatch([{ id, vector }]);
      if (result.rejected > 0 || result.accepted !== 1) throw new Error('SIM RVF: ingest rejected');
    },
    async search(vector: number[], limit: number): Promise<SimVectorHit[]> {
      check(vector);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('SIM RVF: invalid limit');
      const hits = await db.query(vector, limit);
      return hits.filter((h) => typeof h.id === 'string' && Number.isFinite(h.distance))
        .map((h) => ({ id: h.id, score: 1 - h.distance }));
    },
    async close(): Promise<void> {
      if (!closed) { closed = true; await db.close(); }
    },
  };
}
