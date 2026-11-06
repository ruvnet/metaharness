// SPDX-License-Identifier: MIT
//
// memory-rvf — persistent kernel memory on @ruvector/rvf
// (https://www.npmjs.com/package/@ruvector/rvf).
//
// RVF ("RuVector Format") is an HNSW-indexed, single-file vector store with a
// native Node backend (@ruvector/rvf-node). This module maps the kernel's
// memory backend contract onto `RvfDatabase`:
//
//   kernel                      @ruvector/rvf
//   ------------------------    -------------------------------------------
//   namespace                   one `<namespace>.rvf` file under `dir`
//                               (+ its `.rvf.idmap.json` string-id sidecar)
//   insert / insertBatch        RvfDatabase.ingestBatch (re-insert = upsert)
//   search                      RvfDatabase.query(vec, k, { efSearch,
//                                 forceExact })
//   delete                      RvfDatabase.delete(ids)
//   size                        RvfDatabase.status().totalVectors
//   flush                       no-op: every ingest/delete is committed to
//                                 the file when its promise resolves
//   close                       RvfDatabase.close() (releases the writer lock)
//
// What RVF cannot do, and how this module handles it:
//   - Per-vector metadata is not supported by @ruvector/rvf (issue #704:
//     `ingestBatch` throws MetadataNotSupported). So `storedAt` is NOT
//     persisted and hits come back without it; `rankWithDecay` then treats
//     every hit as age 0, i.e. decay does not reorder RVF hits. Namespaces are
//     separate files for the same reason (there is no metadata to filter on).
//   - `forceExact` (exact brute-force search) is passed through by
//     @ruvector/rvf >= 0.4.6 (rvf-node >= 0.4.1). Earlier versions ignore it
//     and search stays on HNSW.
//   - Each `.rvf` file has a single-writer lock. A second backend (in this or
//     another process) opening the same namespace for writing fails with
//     RVF LockHeld. Call `close()` to release it.
//
// RVF is an OPTIONAL peer dependency (^0.3.0 || ^0.4.6). When it is not
// installed, `createRvfBackend()` returns null and the caller keeps its
// default in-process memory. When it IS installed but fails at use time
// (native binding missing, lock held, dimension mismatch), the error is
// thrown rather than silently swallowed.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MemoryHit } from './memory.js';

export type RvfMetric = 'cosine' | 'l2';

/** A memory hit from the RVF backend; carries RVF's raw distance as well. */
export interface RvfMemoryHit extends MemoryHit {
  /**
   * RVF distance (lower = closer). Cosine: `1 - cos_sim`. L2: squared
   * Euclidean distance.
   */
  distance: number;
}

export interface RvfSearchOptions {
  /** Exact brute-force scan instead of HNSW (@ruvector/rvf >= 0.4.6; ignored earlier). */
  exact?: boolean;
  /** HNSW ef_search beam width. RVF default: 100. */
  efSearch?: number;
}

export interface RvfBackendOptions {
  dimensions: number;
  /**
   * Distance metric. Default `'cosine'`, where `score = 1 - distance` is the
   * cosine similarity. For `'l2'`, `score = 1 / (1 + distance)`: a monotone
   * similarity in (0, 1], NOT a cosine similarity. The metric is fixed when a
   * namespace file is created; reopening must use the same metric.
   */
  metric?: RvfMetric;
  /**
   * Directory holding one `.rvf` file per namespace. Created if missing.
   * When omitted, a fresh temporary directory is used and deleted on
   * `close()` — i.e. nothing persists.
   */
  dir?: string;
  /** HNSW M (max edges per node per layer). RVF default: 16. */
  m?: number;
  /** HNSW ef_construction. RVF default: 200. */
  efConstruction?: number;
}

export interface RvfBackendEntry {
  id: string;
  embedding: number[] | Float32Array;
}

export interface RvfBackend {
  /** Absolute directory holding the namespace files. */
  readonly dir: string;
  /** False when `dir` was not given (temporary directory, removed on close). */
  readonly persistent: boolean;
  /** Insert (or replace) one vector. */
  insert(id: string, embedding: number[] | Float32Array, namespace?: string): Promise<void>;
  /** Insert (or replace) many vectors in one RVF commit. */
  insertBatch(entries: RvfBackendEntry[], namespace?: string): Promise<void>;
  /** Top-k nearest neighbours, best first. Unknown namespace → []. */
  search(
    embedding: number[] | Float32Array,
    k: number,
    namespace?: string,
    opts?: RvfSearchOptions,
  ): Promise<RvfMemoryHit[]>;
  /** Delete ids; returns how many were live and removed. */
  delete(ids: string[], namespace?: string): Promise<number>;
  /** Live vectors in one namespace, or across all namespaces on disk. */
  size(namespace?: string): Promise<number>;
  /** Namespaces that exist on disk. */
  namespaces(): string[];
  /** No-op kept for the backend contract: writes are committed per call. */
  flush(): Promise<void>;
  /** Close every open namespace file and release the writer locks. */
  close(): Promise<void>;
}

// ---- minimal structural typing of the @ruvector/rvf surface we use ----

interface RvfDb {
  ingestBatch(entries: Array<{ id: string; vector: Float32Array | number[] }>): Promise<{
    accepted: number;
    rejected: number;
  }>;
  query(
    vector: Float32Array | number[],
    k: number,
    options?: { efSearch?: number; forceExact?: boolean },
  ): Promise<Array<{ id: string; distance: number }>>;
  delete(ids: string[]): Promise<{ deleted: number }>;
  status(): Promise<{ totalVectors: number }>;
  dimension(): Promise<number>;
  close(): Promise<void>;
}

interface RvfDatabaseStatic {
  create(
    path: string,
    options: { dimensions: number; metric?: string; m?: number; efConstruction?: number },
  ): Promise<RvfDb>;
  open(path: string): Promise<RvfDb>;
}

interface RvfModule {
  RvfDatabase?: RvfDatabaseStatic;
  default?: { RvfDatabase?: RvfDatabaseStatic };
}

let _rvf: RvfDatabaseStatic | null | undefined;

async function loadRvf(): Promise<RvfDatabaseStatic | null> {
  if (_rvf !== undefined) return _rvf;
  try {
    // @ts-ignore — @ruvector/rvf is an OPTIONAL peer dependency, so a fresh
    // install without it must still type-check and build.
    const mod = (await import('@ruvector/rvf')) as unknown as RvfModule;
    const db = mod.RvfDatabase ?? mod.default?.RvfDatabase;
    _rvf = db && typeof db.create === 'function' && typeof db.open === 'function' ? db : null;
  } catch {
    _rvf = null;
  }
  return _rvf;
}

/** Is a usable @ruvector/rvf (with `RvfDatabase`) importable in this process? */
export async function isRvfAvailable(): Promise<boolean> {
  return (await loadRvf()) !== null;
}

const NAMESPACE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const FILE_SUFFIX = '.rvf';

function checkNamespace(ns: string): string {
  if (typeof ns !== 'string' || !NAMESPACE_RE.test(ns)) {
    throw new Error(
      `memory-rvf: invalid namespace ${JSON.stringify(ns)} — use 1-128 chars of [A-Za-z0-9._-], not starting with '.'`,
    );
  }
  return ns;
}

function toVector(embedding: number[] | Float32Array, dimensions: number): Float32Array {
  if (!embedding || embedding.length !== dimensions) {
    throw new Error(`memory-rvf: embedding has ${embedding?.length} dims, backend expects ${dimensions}`);
  }
  const v = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) throw new Error(`memory-rvf: embedding[${i}] is not finite`);
  }
  return v;
}

/**
 * Create an RVF-backed memory backend. Returns null only when
 * @ruvector/rvf is not installed (or has no `RvfDatabase`), so the caller
 * can fall back to its default memory. Namespace files are opened lazily.
 */
export async function createRvfBackend(opts: RvfBackendOptions): Promise<RvfBackend | null> {
  const Rvf = await loadRvf();
  if (!Rvf) return null;

  const dimensions = opts.dimensions;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`memory-rvf: dimensions must be a positive integer, got ${dimensions}`);
  }
  const metric: RvfMetric = opts.metric ?? 'cosine';
  if (metric !== 'cosine' && metric !== 'l2') {
    throw new Error(`memory-rvf: unsupported metric ${JSON.stringify(metric)}`);
  }
  const persistent = typeof opts.dir === 'string' && opts.dir.length > 0;
  const dir = persistent ? resolve(opts.dir as string) : mkdtempSync(join(tmpdir(), 'metaharness-rvf-'));
  mkdirSync(dir, { recursive: true });

  const toScore = metric === 'cosine' ? (d: number) => 1 - d : (d: number) => 1 / (1 + d);
  const pathOf = (ns: string) => join(dir, checkNamespace(ns) + FILE_SUFFIX);

  // Cache the promise, not the value, so concurrent first use of a namespace
  // opens/creates the file exactly once.
  const dbs = new Map<string, Promise<RvfDb>>();
  let closed = false;

  const openOrCreate = async (ns: string): Promise<RvfDb> => {
    const p = pathOf(ns);
    if (existsSync(p)) {
      const db = await Rvf.open(p);
      const dim = await db.dimension();
      if (dim !== dimensions) {
        await db.close();
        throw new Error(`memory-rvf: ${p} has ${dim} dims, backend expects ${dimensions}`);
      }
      return db;
    }
    const createOpts: { dimensions: number; metric: string; m?: number; efConstruction?: number } = {
      dimensions,
      metric,
    };
    if (opts.m !== undefined) createOpts.m = opts.m;
    if (opts.efConstruction !== undefined) createOpts.efConstruction = opts.efConstruction;
    return Rvf.create(p, createOpts);
  };

  /** Returns the open db, or null when `create` is false and no file exists. */
  const get = async (ns: string, create: boolean): Promise<RvfDb | null> => {
    if (closed) throw new Error('memory-rvf: backend is closed');
    const cached = dbs.get(ns);
    if (cached) return cached;
    if (!create && !existsSync(pathOf(ns))) return null;
    const pending = openOrCreate(ns);
    dbs.set(ns, pending);
    pending.catch(() => dbs.delete(ns));
    return pending;
  };

  const listNamespaces = (): string[] =>
    readdirSync(dir)
      .filter(f => f.endsWith(FILE_SUFFIX))
      .map(f => f.slice(0, -FILE_SUFFIX.length))
      .filter(ns => NAMESPACE_RE.test(ns))
      .sort();

  const insertBatch = async (entries: RvfBackendEntry[], namespace = 'default'): Promise<void> => {
    if (entries.length === 0) return;
    const rows = entries.map(e => {
      if (typeof e.id !== 'string' || e.id.length === 0) throw new Error('memory-rvf: id must be a non-empty string');
      return { id: e.id, vector: toVector(e.embedding, dimensions) };
    });
    const db = (await get(namespace, true)) as RvfDb;
    const res = await db.ingestBatch(rows);
    if (res.rejected > 0) {
      throw new Error(`memory-rvf: RVF rejected ${res.rejected} of ${rows.length} vectors in namespace ${namespace}`);
    }
  };

  return {
    dir,
    persistent,
    insert(id, embedding, namespace = 'default') {
      return insertBatch([{ id, embedding }], namespace);
    },
    insertBatch,
    async search(embedding, k, namespace = 'default', so = {}) {
      if (!Number.isInteger(k) || k <= 0) throw new Error(`memory-rvf: k must be a positive integer, got ${k}`);
      const vec = toVector(embedding, dimensions);
      const db = await get(namespace, false);
      if (!db) return [];
      const q: { efSearch?: number; forceExact?: boolean } = {};
      if (so.efSearch !== undefined) q.efSearch = so.efSearch;
      if (so.exact) q.forceExact = true;
      const raw = await db.query(vec, k, q);
      return raw.map(r => {
        const score = toScore(r.distance);
        // storedAt is absent: RVF has no per-vector metadata (rvf #704).
        return { id: r.id, score, decayedScore: score, distance: r.distance, namespace };
      });
    },
    async delete(ids, namespace = 'default') {
      if (ids.length === 0) return 0;
      const db = await get(namespace, false);
      if (!db) return 0;
      return (await db.delete(ids)).deleted;
    },
    async size(namespace?: string) {
      const targets = namespace === undefined ? listNamespaces() : [namespace];
      let total = 0;
      for (const ns of targets) {
        const db = await get(ns, false);
        if (db) total += (await db.status()).totalVectors;
      }
      return total;
    },
    namespaces: listNamespaces,
    async flush() {
      if (closed) throw new Error('memory-rvf: backend is closed');
      await Promise.allSettled([...dbs.values()]);
    },
    async close() {
      if (closed) return;
      closed = true;
      const open = await Promise.allSettled([...dbs.values()]);
      dbs.clear();
      for (const r of open) if (r.status === 'fulfilled') await r.value.close();
      if (!persistent) rmSync(dir, { recursive: true, force: true });
    },
  };
}
