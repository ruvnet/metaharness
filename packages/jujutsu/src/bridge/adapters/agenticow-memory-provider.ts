// SPDX-License-Identifier: MIT
//
// Real MemoryBranchProvider backed by agenticow (COW vector branching).
//
// WIRED (all planes): branch/fork create, ingest, checkpoint, rollback,
// promote, diff — these ride agenticow's shipped derive()/promote() primitives.
// ALSO WIRED (agenticow@0.2.0 + @ruvector/rvf-node@0.2.0): cross-branch ANN
// search via the native Rust dual-graph merge (RuVector PRs #617+#618).
// AgenticowQueryProvider.nativeAnn is now true; branch() passes
// {nativeAnn:true} to fork() so the returned fork's query() routes through
// rvf-runtime's query_via_index_cow (recall@10 = 1.0, verified end-to-end).
//
// agenticow is an OPTIONAL peer; use AgenticowMemoryProvider.create() which
// resolves to a provider with available=false if it (or rvf-node) is absent.

import { loadAgenticow } from '../../loader.js';
import type { MemoryDelta, MemoryQueryHit, MemoryRecord } from '../../types.js';
import type {
  MemoryBranchHandle,
  MemoryBranchProvider,
  MemoryQueryProvider,
} from '../ports.js';

/** Structural view of agenticow's AgenticMemory we depend on. */
interface AgenticMemory {
  readonly dimension: number;
  /** True when this fork was created with {nativeAnn:true} (agenticow@0.2.0+). */
  readonly nativeAnn?: boolean;
  ingest(vectors: Float32Array, ids: number[]): { accepted: number };
  delete(ids: number[]): { deleted: number; tombstoned: number };
  query(vector: Float32Array, k?: number, opts?: unknown): Array<{ id: number; distance: number; branch: string }>;
  fork(label?: string, filePath?: string, opts?: { nativeAnn?: boolean }): AgenticMemory;
  branch(label?: string, filePath?: string): AgenticMemory;
  diff(): MemoryDelta;
  promote(target: AgenticMemory): { ingested: number; deleted: number };
  checkpoint(label?: string): { id: string };
  rollback(checkpointId?: string): { restoredTo: string; depth: number };
  close(): void;
}
interface AgenticowModule {
  open(filePath: string, opts?: { dimension?: number; metric?: string }): AgenticMemory;
}

export interface AgenticowOptions {
  /** Path to the base .rvf memory file. */
  basePath: string;
  /** Vector dimension (must match the embedder). Default: 384. */
  dimension?: number;
  metric?: string;
}

interface Entry {
  mem: AgenticMemory;
  spawnCkpt: string;
}

export class AgenticowMemoryProvider implements MemoryBranchProvider {
  private readonly entries = new Map<string, Entry>();
  private bn = 0;

  private constructor(
    public readonly available: boolean,
    private readonly base: AgenticMemory | null,
    private readonly opts: AgenticowOptions,
  ) {}

  /** Resolve the optional peer and open the base memory. Never throws on absence. */
  static async create(opts: AgenticowOptions): Promise<AgenticowMemoryProvider> {
    const mod = (await loadAgenticow()) as AgenticowModule | null;
    if (!mod) return new AgenticowMemoryProvider(false, null, opts);
    try {
      const base = mod.open(opts.basePath, {
        dimension: opts.dimension ?? 384,
        metric: opts.metric ?? 'cosine',
      });
      return new AgenticowMemoryProvider(true, base, opts);
    } catch {
      return new AgenticowMemoryProvider(false, null, opts);
    }
  }

  /** The shared base memory (promote target). For the companion query provider. */
  get baseMemory(): AgenticMemory | null {
    return this.base;
  }

  async branch(label: string): Promise<MemoryBranchHandle> {
    const base = this.must();
    // fork() with nativeAnn=true (agenticow@0.2.0): uses RvfDatabase.branch()
    // instead of derive(), giving the child a real COW engine whose query()
    // routes through the Rust dual-graph ANN merge (PRs #617 + #618).
    // Exact read-through is the correctness fallback if nativeAnn is unavailable.
    const child = base.fork(label, undefined, { nativeAnn: true });
    // Freeze an empty post-spawn restore point so revert() can drop the delta.
    const spawnCkpt = child.checkpoint('spawn').id;
    const id = `mem/${label}-${++this.bn}`;
    this.entries.set(id, { mem: child, spawnCkpt });
    return { id, label };
  }

  async ingest(handle: MemoryBranchHandle, records: MemoryRecord[]): Promise<{ accepted: number }> {
    const { mem } = this.entry(handle);
    const dim = mem.dimension;
    const flat = new Float32Array(records.length * dim);
    const ids: number[] = [];
    for (let i = 0; i < records.length; i++) {
      flat.set(toF32(records[i].vector), i * dim);
      ids.push(records[i].id);
    }
    return mem.ingest(flat, ids);
  }

  async checkpoint(handle: MemoryBranchHandle, label?: string): Promise<{ id: string }> {
    return this.entry(handle).mem.checkpoint(label);
  }

  async rollback(handle: MemoryBranchHandle, checkpointId?: string): Promise<void> {
    const { mem, spawnCkpt } = this.entry(handle);
    mem.rollback(checkpointId ?? spawnCkpt);
  }

  async promote(handle: MemoryBranchHandle): Promise<{ ingested: number; deleted: number }> {
    const base = this.must();
    return this.entry(handle).mem.promote(base);
  }

  async diff(handle: MemoryBranchHandle): Promise<MemoryDelta> {
    return this.entry(handle).mem.diff();
  }

  /** Internal accessor for the companion query provider. */
  _memory(handle: MemoryBranchHandle): AgenticMemory {
    return this.entry(handle).mem;
  }

  /** Close all open handles. */
  close(): void {
    for (const { mem } of this.entries.values()) {
      try {
        mem.close();
      } catch {
        /* ignore */
      }
    }
    try {
      this.base?.close();
    } catch {
      /* ignore */
    }
  }

  private entry(handle: MemoryBranchHandle): Entry {
    const e = this.entries.get(handle.id);
    if (!e) throw new Error(`AgenticowMemoryProvider: no branch ${handle.id}`);
    return e;
  }
  private must(): AgenticMemory {
    if (!this.base) throw new Error('AgenticowMemoryProvider: agenticow unavailable');
    return this.base;
  }
}

/**
 * Cross-branch query backed by agenticow's native COW dual-graph ANN merge.
 *
 * As of agenticow@0.2.0 + @ruvector/rvf-node@0.2.0 (rvf-runtime PRs #617 +
 * #618), each branch spawned by AgenticowMemoryProvider.branch() is a real COW
 * child (created via RvfDatabase.branch()). Its query() routes through
 * query_via_index_cow in Rust, which queries BOTH the child's own HNSW and the
 * parent's HNSW in one call, merges candidates with child-wins semantics, and
 * excludes tombstoned IDs — all without crossing the JS boundary.
 *
 * recall@10 = 1.0000 on the 1200-vector L2 integration test with 60 new,
 * 20 overrides, and 10 tombstones (efSearch=300). Exact read-through remains
 * the correctness fallback when the COW engine is not active.
 */
export class AgenticowQueryProvider implements MemoryQueryProvider {
  /** True: native Rust COW dual-graph ANN merge is now wired (ADR-202). */
  readonly nativeAnn = true;
  constructor(private readonly provider: AgenticowMemoryProvider) {}

  async queryAcrossBranches(
    handle: MemoryBranchHandle,
    vector: Float32Array | number[],
    k = 10,
  ): Promise<MemoryQueryHit[]> {
    const mem = this.provider._memory(handle);
    // mem.query() on a COW child (nativeAnn=true fork) executes the Rust
    // dual-graph merge path automatically. On an exact-mode fork it falls back
    // to the JS chain-walk. Both return the same {id, distance, branch} shape.
    return mem.query(toF32(vector), k);
  }
}

function toF32(v: Float32Array | number[]): Float32Array {
  return v instanceof Float32Array ? v : Float32Array.from(v);
}
