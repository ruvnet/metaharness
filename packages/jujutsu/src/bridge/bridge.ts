// SPDX-License-Identifier: MIT
//
// DualStateBridge — the agenticow <-> agentic-jujutsu lifecycle.
//
// One agent == one CODE/OP branch (jj) + one MEMORY branch (agenticow), created,
// learned, reverted, and merged as a pair. The four lifecycle verbs from the
// design:
//
//   spawn   -> create jj branch + agenticow branch together
//   learn   -> on trajectory finalize, embed the op-sequence + write it into
//              that agent's agenticow COW branch (ReasoningBank-as-agenticow)
//   revert  -> roll back jj op-log + drop the agenticow delta
//   merge   -> merge jj ops + promote the winning agenticow delta into the base
//
// The bridge holds only PORTS, so it works with mock or real adapters and with
// either plane absent (degraded but coherent).

import type { Embedder } from '../embed.js';
import { HashEmbedder } from '../embed.js';
import type { MemoryQueryHit, OpDescriptor } from '../types.js';
import type {
  MemoryBranchHandle,
  MemoryBranchProvider,
  MemoryQueryProvider,
  OpBranchHandle,
  OpBranchProvider,
} from './ports.js';

export interface DualBranch {
  readonly agentId: string;
  /** Live op handle, or null if the op plane is unavailable. */
  readonly op: OpBranchHandle | null;
  /** Live memory handle, or null if the memory plane is unavailable. */
  readonly mem: MemoryBranchHandle | null;
}

export interface LearnResult {
  trajectoryId: string;
  successScore: number;
  opCount: number;
  /** Records embedded + ingested into the memory branch. */
  ingested: number;
  /** Sides that were actually exercised. */
  opPlane: boolean;
  memPlane: boolean;
}

export interface BridgeOptions {
  embedder?: Embedder;
  /** Optional cross-branch query provider (stubbed plane). */
  queryProvider?: MemoryQueryProvider;
}

export class DualStateBridge {
  private readonly embedder: Embedder;
  private readonly branches = new Map<string, DualBranch>();
  /** Monotonic id source for memory records (op -> vector). */
  private nextRecordId = 1;

  constructor(
    private readonly opProvider: OpBranchProvider,
    private readonly memProvider: MemoryBranchProvider,
    private readonly opts: BridgeOptions = {},
  ) {
    this.embedder = opts.embedder ?? new HashEmbedder(384);
  }

  /** Which planes are live. */
  status(): { opPlane: boolean; memPlane: boolean; nativeAnn: boolean } {
    return {
      opPlane: this.opProvider.available,
      memPlane: this.memProvider.available,
      nativeAnn: this.opts.queryProvider?.nativeAnn ?? false,
    };
  }

  /** spawn -> create jj branch + agenticow branch together. */
  async spawn(agentId: string): Promise<DualBranch> {
    if (this.branches.has(agentId)) {
      throw new Error(`DualStateBridge: agent "${agentId}" already spawned`);
    }
    const op = this.opProvider.available ? await this.opProvider.spawn(agentId) : null;
    const mem = this.memProvider.available ? await this.memProvider.branch(agentId) : null;
    const branch: DualBranch = { agentId, op, mem };
    this.branches.set(agentId, branch);
    return branch;
  }

  /**
   * learn -> finalize the op trajectory, embed the op-sequence, and write it
   * into the agent's COW memory branch. ReasoningBank-as-agenticow.
   */
  async learn(agentId: string, successScore: number, critique?: string): Promise<LearnResult> {
    const b = this.require(agentId);
    let trajectoryId = '';
    let ops: OpDescriptor[] = [];
    let opCount = 0;

    if (b.op && this.opProvider.available) {
      const summary = await this.opProvider.finalize(b.op, successScore, critique);
      trajectoryId = summary.trajectoryId || (b.op.trajectoryId ?? '');
      ops = await this.opProvider.opSequence(b.op);
      opCount = ops.length;
    }

    let ingested = 0;
    if (b.mem && this.memProvider.available && ops.length > 0) {
      const records = ops.map((op) => ({
        id: this.nextRecordId++,
        vector: this.embedder.embed(opToText(op)),
      }));
      const res = await this.memProvider.ingest(b.mem, records);
      ingested = res.accepted;
    }

    return {
      trajectoryId,
      successScore,
      opCount,
      ingested,
      opPlane: Boolean(b.op),
      memPlane: Boolean(b.mem),
    };
  }

  /** revert -> jj undo + drop the agenticow delta. */
  async revert(agentId: string, memoryCheckpointId?: string): Promise<void> {
    const b = this.require(agentId);
    if (b.op && this.opProvider.available) await this.opProvider.undo(b.op);
    if (b.mem && this.memProvider.available) await this.memProvider.rollback(b.mem, memoryCheckpointId);
  }

  /** merge -> merge jj ops + promote the winning agenticow delta into the base. */
  async merge(agentId: string): Promise<{ ingested: number; deleted: number }> {
    const b = this.require(agentId);
    if (b.op && this.opProvider.available) await this.opProvider.merge(b.op);
    let promotion = { ingested: 0, deleted: 0 };
    if (b.mem && this.memProvider.available) promotion = await this.memProvider.promote(b.mem);
    this.branches.delete(agentId);
    return promotion;
  }

  /**
   * Cross-branch memory query. STUB-aware: delegates to the injected
   * MemoryQueryProvider (native ANN pending — RuVector PR #617). Throws a clear
   * error if no provider was supplied.
   */
  async queryMemory(
    agentId: string,
    vector: Float32Array | number[],
    k = 10,
  ): Promise<MemoryQueryHit[]> {
    const b = this.require(agentId);
    if (!b.mem) throw new Error('DualStateBridge: memory plane unavailable for this agent');
    const qp = this.opts.queryProvider;
    if (!qp) {
      throw new Error(
        'DualStateBridge: no MemoryQueryProvider injected. Cross-branch ANN is a ' +
          'stubbed plane (RuVector PR #617 pending) — inject a provider to query.',
      );
    }
    return qp.queryAcrossBranches(b.mem, vector, k);
  }

  /** Embed arbitrary text with the bridge's embedder (helper for callers). */
  embed(text: string): Float32Array {
    return this.embedder.embed(text);
  }

  private require(agentId: string): DualBranch {
    const b = this.branches.get(agentId);
    if (!b) throw new Error(`DualStateBridge: agent "${agentId}" not spawned`);
    return b;
  }
}

/** Stable textual rendering of an op for embedding. */
function opToText(op: OpDescriptor): string {
  return `${op.operationType} ${op.command} ${op.success ? 'ok' : 'fail'}`;
}
