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
//   insert / insertBatch        RvfDatabase.ingestBatch (re-insert = upsert),
//                                 with per-vector metadata { storedAt, ... }
//   search                      RvfDatabase.query(vec, k, { efSearch,
//                                 forceExact, filter }); hits carry
//                                 `storedAt` and `metadata`
//   delete                      RvfDatabase.delete(ids)
//   size                        RvfDatabase.status().totalVectors
//   flush                       no-op: every ingest/delete is committed to
//                                 the file when its promise resolves
//   close                       RvfDatabase.close() (releases the writer lock)
//
// Per-vector metadata (ruvector #704) needs @ruvector/rvf >= 0.4.7 with
// rvf-node >= 0.4.2. Every insert stores `storedAt` (ms since epoch, default
// Date.now()) plus any caller `metadata`; hits return both, so `rankWithDecay`
// can reorder them by age, and `search(..., { filter })` filters on them.
// Earlier versions reject metadata with MetadataNotSupported before writing
// anything; this module then retries the same write WITHOUT metadata and
// stays in that mode for the backend's lifetime, i.e. it behaves exactly as
// kernel 0.1.5 did (no `storedAt` on hits, decay treats them as age 0).
// Vectors written before metadata existed (e.g. by kernel 0.1.5) also come
// back without `storedAt`. Namespaces stay separate files.
//
// What RVF cannot do, and how this module handles it:
//   - `forceExact` (exact brute-force search) is passed through by
//     @ruvector/rvf >= 0.4.6 (rvf-node >= 0.4.1). Earlier versions ignore it
//     and search stays on HNSW.
//   - Each `.rvf` file has a single-writer lock. A second backend (in this or
//     another process) opening the same namespace for writing fails with
//     RVF LockHeld. Call `close()` to release it.
//
// RVF is an OPTIONAL peer dependency (^0.3.0 || ^0.4.7). When it is not
// installed, `createRvfBackend()` returns null and the caller keeps its
// default in-process memory. When it IS installed but fails at use time
// (native binding missing, lock held, dimension mismatch), the error is
// thrown rather than silently swallowed.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MemoryHit } from './memory.js';

export type RvfMetric = 'cosine' | 'l2';

/**
 * A per-vector metadata value (@ruvector/rvf >= 0.4.7). Numbers are stored as
 * f64, objects and arrays as JSON. A field keeps the type of the first
 * non-null value written to it; writing another type throws RVF's
 * MetadataTypeConflict (0xff09).
 */
export type RvfMetadataValue = string | number | boolean | null | object;

/** Metadata key this module reserves for the insert timestamp. */
export const STORED_AT_FIELD = 'storedAt';

type FilterLiteral = number | string | boolean;
/**
 * A metadata filter, passed through to RVF. Leaves name a metadata key with
 * `field` (`storedAt` or a key from your `metadata`).
 */
export type RvfMetadataFilter =
  | { op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; field: string; value: FilterLiteral }
  | { op: 'in'; field: string; values: FilterLiteral[] }
  | { op: 'range'; field: string; low: FilterLiteral; high: FilterLiteral }
  | { op: 'and' | 'or'; exprs: RvfMetadataFilter[] }
  | { op: 'not'; expr: RvfMetadataFilter };

/** A memory hit from the RVF backend; carries RVF's raw distance as well. */
export interface RvfMemoryHit extends MemoryHit {
  /**
   * RVF distance (lower = closer). Cosine: `1 - cos_sim`. L2: squared
   * Euclidean distance.
   */
  distance: number;
  /**
   * The caller metadata stored with the vector (without `storedAt`, which is
   * lifted to `MemoryHit.storedAt`). Absent when the vector has none, or on
   * @ruvector/rvf < 0.4.7.
   */
  metadata?: Record<string, RvfMetadataValue>;
}

export interface RvfSearchOptions {
  /** Exact brute-force scan instead of HNSW (@ruvector/rvf >= 0.4.6; ignored earlier). */
  exact?: boolean;
  /** HNSW ef_search beam width. RVF default: 100. */
  efSearch?: number;
  /**
   * Metadata filter (@ruvector/rvf >= 0.4.7). Throws when the installed RVF
   * has no metadata support rather than returning unfiltered hits. A filter
   * that keeps most of the store is approximate on HNSW; add `exact: true`
   * for exact filtered results.
   */
  filter?: RvfMetadataFilter;
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
  /** Insert time in ms since epoch. Default: `Date.now()` at insert. */
  storedAt?: number;
  /** Extra per-vector metadata, e.g. `{ source, tags }`. `storedAt` is reserved. */
  metadata?: Record<string, RvfMetadataValue>;
}

export interface RvfInsertOptions {
  /** Insert time in ms since epoch. Default: `Date.now()` at insert. */
  storedAt?: number;
  /** Extra per-vector metadata, e.g. `{ source, tags }`. `storedAt` is reserved. */
  metadata?: Record<string, RvfMetadataValue>;
}

export interface RvfBackend {
  /** Absolute directory holding the namespace files. */
  readonly dir: string;
  /** False when `dir` was not given (temporary directory, removed on close). */
  readonly persistent: boolean;
  /**
   * Whether writes carry per-vector metadata. True on @ruvector/rvf >= 0.4.7
   * (rvf-node >= 0.4.2); becomes false after the first write that RVF rejects
   * with MetadataNotSupported, and stays false.
   */
  readonly metadataSupported: boolean;
  /** Insert (or replace) one vector. */
  insert(
    id: string,
    embedding: number[] | Float32Array,
    namespace?: string,
    opts?: RvfInsertOptions,
  ): Promise<void>;
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
  ingestBatch(
    entries: Array<{ id: string; vector: Float32Array | number[]; metadata?: Record<string, RvfMetadataValue> }>,
  ): Promise<{
    accepted: number;
    rejected: number;
  }>;
  query(
    vector: Float32Array | number[],
    k: number,
    options?: { efSearch?: number; forceExact?: boolean; filter?: RvfMetadataFilter },
  ): Promise<Array<{ id: string; distance: number; metadata?: Record<string, RvfMetadataValue> }>>;
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
  RvfErrorCode?: Record<string, number>;
  default?: { RvfDatabase?: RvfDatabaseStatic; RvfErrorCode?: Record<string, number> };
}

interface LoadedRvf {
  db: RvfDatabaseStatic;
  /**
   * The SDK declares MetadataTypeConflict (added with metadata support in
   * @ruvector/rvf 0.4.7). A cheap first guess only: an older rvf-node under a
   * 0.4.7 SDK still rejects metadata, which the write path detects.
   */
  sdkHasMetadata: boolean;
}

/** RvfErrorCode.MetadataNotSupported (0xff04). */
const METADATA_NOT_SUPPORTED = 0xff04;

let _rvf: LoadedRvf | null | undefined;

async function loadRvf(): Promise<LoadedRvf | null> {
  if (_rvf !== undefined) return _rvf;
  try {
    // @ts-ignore — @ruvector/rvf is an OPTIONAL peer dependency, so a fresh
    // install without it must still type-check and build.
    const mod = (await import('@ruvector/rvf')) as unknown as RvfModule;
    const db = mod.RvfDatabase ?? mod.default?.RvfDatabase;
    const codes = mod.RvfErrorCode ?? mod.default?.RvfErrorCode;
    _rvf =
      db && typeof db.create === 'function' && typeof db.open === 'function'
        ? { db, sdkHasMetadata: typeof codes?.MetadataTypeConflict === 'number' }
        : null;
  } catch {
    _rvf = null;
  }
  return _rvf;
}

function isMetadataNotSupported(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === METADATA_NOT_SUPPORTED;
}

function checkStoredAt(storedAt: number | undefined, fallback: number): number {
  if (storedAt === undefined) return fallback;
  if (typeof storedAt !== 'number' || !Number.isFinite(storedAt)) {
    throw new Error(`memory-rvf: storedAt must be a finite number (ms since epoch), got ${storedAt}`);
  }
  return storedAt;
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
  const loaded = await loadRvf();
  if (!loaded) return null;
  const Rvf = loaded.db;
  let metadataSupported = loaded.sdkHasMetadata;

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
    const now = Date.now();
    const rows = entries.map(e => {
      if (typeof e.id !== 'string' || e.id.length === 0) throw new Error('memory-rvf: id must be a non-empty string');
      if (e.metadata !== undefined && (typeof e.metadata !== 'object' || e.metadata === null || Array.isArray(e.metadata))) {
        throw new Error('memory-rvf: metadata must be a plain object');
      }
      if (e.metadata && STORED_AT_FIELD in e.metadata) {
        throw new Error(`memory-rvf: metadata key "${STORED_AT_FIELD}" is reserved; pass storedAt instead`);
      }
      const storedAt = checkStoredAt(e.storedAt, now);
      return {
        id: e.id,
        vector: toVector(e.embedding, dimensions),
        metadata: { ...e.metadata, [STORED_AT_FIELD]: storedAt },
      };
    });
    const db = (await get(namespace, true)) as RvfDb;
    const plain = () => rows.map(({ id, vector }) => ({ id, vector }));
    let res: { accepted: number; rejected: number };
    if (!metadataSupported) {
      res = await db.ingestBatch(plain());
    } else {
      try {
        res = await db.ingestBatch(rows);
      } catch (err) {
        // RVF < 0.4.7 (or rvf-node < 0.4.2) rejects metadata before writing.
        if (!isMetadataNotSupported(err)) throw err;
        metadataSupported = false;
        res = await db.ingestBatch(plain());
      }
    }
    if (res.rejected > 0) {
      throw new Error(`memory-rvf: RVF rejected ${res.rejected} of ${rows.length} vectors in namespace ${namespace}`);
    }
  };

  return {
    dir,
    persistent,
    get metadataSupported() {
      return metadataSupported;
    },
    insert(id, embedding, namespace = 'default', io = {}) {
      return insertBatch([{ id, embedding, storedAt: io.storedAt, metadata: io.metadata }], namespace);
    },
    insertBatch,
    async search(embedding, k, namespace = 'default', so = {}) {
      if (!Number.isInteger(k) || k <= 0) throw new Error(`memory-rvf: k must be a positive integer, got ${k}`);
      if (so.filter !== undefined && !metadataSupported) {
        throw new Error('memory-rvf: metadata filters need @ruvector/rvf >= 0.4.7 with rvf-node >= 0.4.2');
      }
      const vec = toVector(embedding, dimensions);
      const db = await get(namespace, false);
      if (!db) return [];
      const q: { efSearch?: number; forceExact?: boolean; filter?: RvfMetadataFilter } = {};
      if (so.efSearch !== undefined) q.efSearch = so.efSearch;
      if (so.exact) q.forceExact = true;
      if (so.filter !== undefined) q.filter = so.filter;
      const raw = await db.query(vec, k, q);
      return raw.map(r => {
        const score = toScore(r.distance);
        const hit: RvfMemoryHit = { id: r.id, score, decayedScore: score, distance: r.distance, namespace };
        if (r.metadata) {
          const { [STORED_AT_FIELD]: storedAt, ...rest } = r.metadata;
          if (typeof storedAt === 'number') hit.storedAt = storedAt;
          if (Object.keys(rest).length > 0) hit.metadata = rest;
        }
        return hit;
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
