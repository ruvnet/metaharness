// SPDX-License-Identifier: MIT
//
// In-memory mock adapters. They make the bridge fully exercisable offline (no
// jj CLI, no native addon, no rvf-node) — used by the smoke test and unit tests,
// and as a graceful fallback. The mock memory provider keeps real vectors so the
// mock query provider can do honest brute-force cosine k-NN, demonstrating the
// shape of the (eventually native) cross-branch search.

import type { MemoryDelta, MemoryQueryHit, MemoryRecord, OpDescriptor, TrajectorySummary } from '../../types.js';
import type {
  MemoryBranchHandle,
  MemoryBranchProvider,
  MemoryQueryProvider,
  OpBranchHandle,
  OpBranchProvider,
} from '../ports.js';

interface MockTrajectory {
  id: string;
  ops: OpDescriptor[];
  finalized?: { score: number; critique?: string };
}

export class MockOpProvider implements OpBranchProvider {
  readonly available = true;
  private seq = 0;
  private readonly trajectories = new Map<string, MockTrajectory>();
  /** Optional seed ops appended at spawn so learn() has something to embed. */
  constructor(private readonly seedOps = 3) {}

  async spawn(agentId: string): Promise<OpBranchHandle> {
    const trajectoryId = `traj-${agentId}-${++this.seq}`;
    const ops: OpDescriptor[] = [];
    for (let i = 0; i < this.seedOps; i++) ops.push(this.mkOp(agentId, i));
    this.trajectories.set(trajectoryId, { id: trajectoryId, ops });
    return { id: `op/${agentId}`, name: agentId, trajectoryId };
  }

  async recordOp(handle: OpBranchHandle): Promise<void> {
    const t = this.traj(handle);
    t.ops.push(this.mkOp(handle.name, t.ops.length));
  }

  async finalize(handle: OpBranchHandle, successScore: number, critique?: string): Promise<TrajectorySummary> {
    const t = this.traj(handle);
    t.finalized = { score: successScore, critique };
    return { trajectoryId: t.id, successScore, critique, opCount: t.ops.length };
  }

  async opSequence(handle: OpBranchHandle): Promise<OpDescriptor[]> {
    return [...this.traj(handle).ops];
  }

  async undo(handle: OpBranchHandle): Promise<void> {
    this.traj(handle).ops.pop();
  }

  async merge(handle: OpBranchHandle): Promise<void> {
    this.trajectories.delete(handle.trajectoryId!);
  }

  private traj(handle: OpBranchHandle): MockTrajectory {
    const t = this.trajectories.get(handle.trajectoryId!);
    if (!t) throw new Error(`MockOpProvider: no trajectory for ${handle.id}`);
    return t;
  }

  private mkOp(agent: string, i: number): OpDescriptor {
    return {
      id: `${agent}-op-${i}`,
      operationId: `${agent}@host-${i}`,
      operationType: ['commit', 'new', 'describe', 'squash'][i % 4],
      command: `jj ${['commit', 'new', 'describe', 'squash'][i % 4]} ${agent} step ${i}`,
      user: agent,
      timestamp: new Date(Date.now() + i).toISOString(),
      durationMs: 1 + i,
      success: true,
    };
  }
}

interface MockBranch {
  id: string;
  label: string;
  records: Map<number, Float32Array>;
  tombstones: Set<number>;
  checkpoints: Array<{ id: string; records: Map<number, Float32Array> }>;
}

export class MockMemoryProvider implements MemoryBranchProvider {
  readonly available = true;
  private bn = 0;
  private cn = 0;
  private readonly branches = new Map<string, MockBranch>();
  /** Shared "base" memory that promote() writes into. */
  readonly base = new Map<number, Float32Array>();

  async branch(label: string): Promise<MemoryBranchHandle> {
    const id = `mem/${label}-${++this.bn}`;
    this.branches.set(id, { id, label, records: new Map(), tombstones: new Set(), checkpoints: [] });
    return { id, label };
  }

  async ingest(handle: MemoryBranchHandle, records: MemoryRecord[]): Promise<{ accepted: number }> {
    const b = this.br(handle);
    for (const r of records) {
      b.records.set(r.id, toF32(r.vector));
      b.tombstones.delete(r.id);
    }
    return { accepted: records.length };
  }

  async checkpoint(handle: MemoryBranchHandle, label?: string): Promise<{ id: string }> {
    const b = this.br(handle);
    const id = `ckpt-${label ?? ''}-${++this.cn}`;
    b.checkpoints.push({ id, records: new Map(b.records) });
    return { id };
  }

  async rollback(handle: MemoryBranchHandle, checkpointId?: string): Promise<void> {
    const b = this.br(handle);
    if (b.checkpoints.length === 0) {
      b.records.clear();
      b.tombstones.clear();
      return;
    }
    const ck = checkpointId
      ? b.checkpoints.find((c) => c.id === checkpointId)
      : b.checkpoints[b.checkpoints.length - 1];
    if (!ck) throw new Error(`MockMemoryProvider: checkpoint ${checkpointId} not found`);
    b.records = new Map(ck.records);
    b.tombstones.clear();
  }

  async promote(handle: MemoryBranchHandle): Promise<{ ingested: number; deleted: number }> {
    const b = this.br(handle);
    for (const [id, v] of b.records) this.base.set(id, v);
    for (const id of b.tombstones) this.base.delete(id);
    return { ingested: b.records.size, deleted: b.tombstones.size };
  }

  async diff(handle: MemoryBranchHandle): Promise<MemoryDelta> {
    const b = this.br(handle);
    return {
      added: [...b.records.keys()].sort((a, c) => a - c),
      overridden: [],
      deleted: [...b.tombstones].sort((a, c) => a - c),
    };
  }

  /** Internal accessor for the mock query provider. */
  _records(handle: MemoryBranchHandle): Map<number, Float32Array> {
    return this.br(handle).records;
  }

  private br(handle: MemoryBranchHandle): MockBranch {
    const b = this.branches.get(handle.id);
    if (!b) throw new Error(`MockMemoryProvider: no branch ${handle.id}`);
    return b;
  }
}

/** Honest brute-force cosine k-NN over a MockMemoryProvider branch. */
export class MockQueryProvider implements MemoryQueryProvider {
  readonly nativeAnn = false;
  constructor(private readonly mem: MockMemoryProvider) {}

  async queryAcrossBranches(
    handle: MemoryBranchHandle,
    vector: Float32Array | number[],
    k = 10,
  ): Promise<MemoryQueryHit[]> {
    const q = toF32(vector);
    const hits: MemoryQueryHit[] = [];
    for (const [id, v] of this.mem._records(handle)) {
      hits.push({ id, distance: 1 - cosine(q, v), branch: handle.label });
    }
    return hits.sort((a, b) => a.distance - b.distance).slice(0, k);
  }
}

function toF32(v: Float32Array | number[]): Float32Array {
  return v instanceof Float32Array ? v : Float32Array.from(v);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
