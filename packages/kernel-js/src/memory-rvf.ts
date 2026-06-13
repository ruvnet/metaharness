// SPDX-License-Identifier: MIT
//
// memory-rvf — graceful-fallback wrapper over @ruvector/rvf
// (https://www.npmjs.com/package/@ruvector/rvf).
//
// RVF is "RuVector Format — unified TypeScript SDK for vector intelligence":
// HNSW-indexed binary vector format with SIMD, dual-target (TypeScript
// runtime + optional @ruvector/rvf-wasm). When the user has RVF installed
// AND wants RVF-backed memory storage, the kernel uses it; otherwise the
// memory subsystem keeps using its plain in-process HNSW.
//
// RVF is declared as an OPTIONAL peer dep so the kernel doesn't bloat
// install size for users who don't need it. The pairing matters most
// for RVM-deployed harnesses — RVM's wasm guest can run rvf-wasm
// inside the partition for hardware-isolated vector storage.

import type { MemoryHit } from './memory.js';

export interface RvfBackend {
  /** Insert a vector into the index. */
  insert(id: string, embedding: number[], namespace?: string): Promise<void>;
  /** Search by embedding similarity. */
  search(embedding: number[], k: number, namespace?: string): Promise<MemoryHit[]>;
  /** Total items currently indexed. */
  size(): Promise<number>;
  /** Persist + flush. */
  flush(): Promise<void>;
}

interface RvfModule {
  // Conservative typing — we only consume the methods we use, the real
  // package surface is richer.
  createIndex?(opts: { dimensions: number; metric?: 'cosine' | 'l2' }): Promise<RvfIndex>;
  default?: { createIndex?(opts: { dimensions: number; metric?: 'cosine' | 'l2' }): Promise<RvfIndex> };
}

interface RvfIndex {
  add(id: string, vec: number[]): Promise<void>;
  search(vec: number[], k: number): Promise<Array<{ id: string; score: number }>>;
  count?(): Promise<number>;
  size?(): Promise<number>;
  flush?(): Promise<void>;
}

let _rvf: RvfModule | null | undefined;

async function loadRvf(): Promise<RvfModule | null> {
  if (_rvf !== undefined) return _rvf;
  try {
    _rvf = await import('@ruvector/rvf') as unknown as RvfModule;
    return _rvf;
  } catch {
    _rvf = null;
    return null;
  }
}

/** Is the RVF package installed and importable in the current process? */
export async function isRvfAvailable(): Promise<boolean> {
  return (await loadRvf()) !== null;
}

/**
 * Create an RVF-backed backend. Returns null if RVF isn't installed —
 * caller falls back to the in-process HNSW.
 */
export async function createRvfBackend(opts: {
  dimensions: number;
  metric?: 'cosine' | 'l2';
}): Promise<RvfBackend | null> {
  const mod = await loadRvf();
  if (!mod) return null;
  const createIndex = mod.createIndex ?? mod.default?.createIndex;
  if (typeof createIndex !== 'function') return null;
  const indexByNs = new Map<string, RvfIndex>();
  const ensure = async (ns: string): Promise<RvfIndex> => {
    let idx = indexByNs.get(ns);
    if (!idx) {
      idx = await createIndex({ dimensions: opts.dimensions, metric: opts.metric ?? 'cosine' });
      indexByNs.set(ns, idx);
    }
    return idx;
  };
  return {
    async insert(id, embedding, namespace = 'default') {
      const idx = await ensure(namespace);
      await idx.add(id, embedding);
    },
    async search(embedding, k, namespace = 'default') {
      const idx = await ensure(namespace);
      const raw = await idx.search(embedding, k);
      return raw.map(r => ({
        id: r.id,
        score: r.score,
        decayedScore: r.score, // memory.rankWithDecay applies decay separately
        namespace,
      }));
    },
    async size() {
      let total = 0;
      for (const idx of indexByNs.values()) {
        const count = await (idx.count?.() ?? idx.size?.() ?? Promise.resolve(0));
        total += count ?? 0;
      }
      return total;
    },
    async flush() {
      for (const idx of indexByNs.values()) {
        if (typeof idx.flush === 'function') await idx.flush();
      }
    },
  };
}
