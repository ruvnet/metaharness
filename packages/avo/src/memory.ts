// SPDX-License-Identifier: MIT

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sha256 } from './crypto.js';
import type { GovernedMemory } from './ports.js';
import type { StructuredMemoryRecord, VariationCheckpoint } from './types.js';

export interface MemoryEmbedder {
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
}

interface QueryHit { id: number; distance: number; text?: string }
interface AgenticMemory {
  ingest(vector: Float32Array, payload: { id: number; text: string }): { accepted: number };
  query(vector: Float32Array, k?: number): QueryHit[];
  fork(label?: string, filePath?: string, options?: { nativeAnn?: boolean }): AgenticMemory;
  checkpoint(label?: string): { id: string };
  rollback(checkpointId?: string): unknown;
  promote(target?: AgenticMemory): unknown;
  save(manifestPath: string): string;
  status?(): { totalVectors: number };
  close(): void;
}
interface AgenticowModule {
  open(filePath: string, options?: { dimension?: number; metric?: string }): AgenticMemory;
  AgenticMemory?: { load(manifestPath: string): AgenticMemory };
}

export interface RvfGovernedMemoryOptions {
  path: string;
  embedder: MemoryEmbedder;
  manifestPath?: string;
}

/** Production structured memory backed by agenticow's RVF COW store. */
export class RvfGovernedMemory implements GovernedMemory {
  private branchMemory: AgenticMemory;
  private nextId = 1;
  private _cursor: string | null = null;
  private pending: StructuredMemoryRecord[] = [];

  private constructor(
    private readonly base: AgenticMemory,
    private readonly options: RvfGovernedMemoryOptions,
    working?: AgenticMemory,
    nextId?: number,
  ) {
    this.branchMemory = working ?? base;
    this.nextId = nextId ?? (this.branchMemory.status?.().totalVectors ?? 0) + 1;
  }

  static async create(options: RvfGovernedMemoryOptions): Promise<RvfGovernedMemory> {
    const specifier = 'agenticow';
    let loaded: unknown;
    try {
      loaded = await import(specifier);
    } catch (error) {
      throw new Error(`@metaharness/avo: RVF memory requires optional peer agenticow (${(error as Error).message})`);
    }
    const module = ((loaded as { default?: unknown }).default ?? loaded) as AgenticowModule;
    await mkdir(dirname(resolve(options.path)), { recursive: true });
    const recovery = `${resolve(options.path)}.working.json`;
    if (existsSync(recovery) && module.AgenticMemory?.load) {
      // The loaded manifest owns the full chain. Opening the base separately
      // would create a second writer/reader ownership graph and make the next
      // derive fail closed with RVF LockHeld.
      return new RvfGovernedMemory(
        module.AgenticMemory.load(recovery),
        options,
        undefined,
        await nextIdFromManifest(recovery),
      );
    }
    const base = module.open(resolve(options.path), {
      dimension: options.embedder.dimensions,
      metric: 'cosine',
    });
    return new RvfGovernedMemory(base, options);
  }

  get cursor(): string | null { return this._cursor; }

  async branch(label: string): Promise<void> {
    // Use AgenticOW's exact COW derive path. Native ANN branches hold the RVF
    // writer lock and cannot themselves derive the fresh child required by
    // checkpoint(); exact branches preserve checkpoint/rollback semantics and
    // still query across the complete parent chain.
    this.branchMemory = this.base.fork(label);
    this.pending = [];
    this._cursor = `branch:${label}`;
    this.saveWorking();
  }

  async retrieve(query: string, limit: number): Promise<StructuredMemoryRecord[]> {
    const vector = await this.options.embedder.embed(query);
    return this.branchMemory.query(vector, limit)
      .flatMap((hit) => {
        if (!hit.text) return [];
        try { return [JSON.parse(hit.text) as StructuredMemoryRecord]; } catch { return []; }
      });
  }

  async buffer(record: StructuredMemoryRecord): Promise<void> {
    // Schema projection is deliberate: no free-form/raw reasoning field exists.
    const text = JSON.stringify(record);
    const vector = await this.options.embedder.embed(text);
    this.branchMemory.ingest(vector, { id: this.nextId++, text });
    this.pending.push(structuredClone(record));
    this._cursor = `record:${record.id}`;
    this.saveWorking();
  }

  async checkpoint(label: string): Promise<string> {
    const checkpoint = this.branchMemory.checkpoint(label);
    this._cursor = `checkpoint:${checkpoint.id}`;
    this.saveWorking();
    return checkpoint.id;
  }

  async rollback(checkpointId?: string): Promise<void> {
    this.branchMemory.rollback(checkpointId);
    this.pending = [];
    this._cursor = checkpointId ? `rollback:${checkpointId}` : 'rollback:latest';
    this.saveWorking();
  }

  async consolidate(): Promise<void> {
    this.branchMemory.promote(this.base);
    this.pending = [];
    this._cursor = 'promoted';
    this.saveWorking();
  }

  async verify(records: StructuredMemoryRecord[]): Promise<boolean> {
    return records.every((record) =>
      !Object.hasOwn(record as object, 'reasoning')
      && !Object.hasOwn(record as object, 'chainOfThought')
      && typeof record.id === 'string'
      && Array.isArray(record.actionsAttempted));
  }

  async packageCheckpoint(checkpoint: VariationCheckpoint): Promise<string> {
    const manifestPath = resolve(this.options.manifestPath ?? `${this.options.path}.manifest.json`);
    await mkdir(dirname(manifestPath), { recursive: true });
    const memoryManifest = this.branchMemory.save(`${manifestPath}.memory.json`);
    const envelope = {
      schema: 1,
      type: 'metaharness-avo-runtime',
      runtimeVersion: checkpoint.runtimeVersion,
      policyVersion: checkpoint.policyVersion,
      evaluatorVersion: checkpoint.evaluatorVersion,
      checkpointHash: checkpoint.checkpointHash,
      checkpointSignature: checkpoint.signature,
      signer: checkpoint.signer,
      rvfPath: resolve(this.options.path),
      memoryManifest,
      stateHash: checkpoint.state.stateHash,
      contentAddress: sha256([checkpoint.checkpointHash, memoryManifest]),
    };
    await writeFile(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    return manifestPath;
  }

  async close(): Promise<void> {
    this.saveWorking();
    try { this.branchMemory.close(); } finally { if (this.branchMemory !== this.base) this.base.close(); }
  }

  private saveWorking(): void {
    this.branchMemory.save(`${resolve(this.options.path)}.working.json`);
  }
}

async function nextIdFromManifest(path: string): Promise<number> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as {
    nodes?: Array<{ texts?: Record<string, string>; editIds?: number[] }>;
  };
  let maximum = 0;
  for (const node of manifest.nodes ?? []) {
    for (const id of Object.keys(node.texts ?? {})) maximum = Math.max(maximum, Number(id));
    for (const id of node.editIds ?? []) maximum = Math.max(maximum, id);
  }
  return maximum + 1;
}

/** Test-only memory seam. Production callers should use RvfGovernedMemory. */
export class EphemeralGovernedMemory implements GovernedMemory {
  private records: StructuredMemoryRecord[] = [];
  private snapshots = new Map<string, StructuredMemoryRecord[]>();
  private _cursor: string | null = null;
  get cursor(): string | null { return this._cursor; }
  async branch(label: string): Promise<void> { this._cursor = `branch:${label}`; }
  async retrieve(_query: string, limit: number): Promise<StructuredMemoryRecord[]> { return this.records.slice(-limit); }
  async buffer(record: StructuredMemoryRecord): Promise<void> { this.records.push(structuredClone(record)); this._cursor = record.id; }
  async checkpoint(label: string): Promise<string> { this.snapshots.set(label, structuredClone(this.records)); return label; }
  async rollback(checkpointId?: string): Promise<void> { if (checkpointId && this.snapshots.has(checkpointId)) this.records = structuredClone(this.snapshots.get(checkpointId)!); }
  async consolidate(): Promise<void> {}
  async verify(records: StructuredMemoryRecord[]): Promise<boolean> { return records.every((record) => !Object.hasOwn(record as object, 'reasoning')); }
  async packageCheckpoint(): Promise<undefined> { return undefined; }
  async close(): Promise<void> {}
}
