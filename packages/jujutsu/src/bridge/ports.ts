// SPDX-License-Identifier: MIT
//
// Ports for the agenticow <-> agentic-jujutsu dual-state bridge.
//
// The bridge depends ONLY on these interfaces (ports-and-adapters / hexagonal),
// so it is testable offline with mock adapters and degrades cleanly when a
// native peer is missing. Two independent state planes:
//
//   OpBranchProvider     -> the CODE/OP branch  (agentic-jujutsu jj op-log)
//   MemoryBranchProvider -> the MEMORY branch   (agenticow COW vector branch)
//
// The memory-QUERY plane is split out (MemoryQueryProvider) and STUBBED on
// purpose: agenticow's native ANN-across-branch (RuVector PR #617) is still in
// flight. Branch create / ingest / rollback / promote / diff are wired to real
// agenticow today; cross-branch search lands with that PR.

import type {
  MemoryDelta,
  MemoryQueryHit,
  MemoryRecord,
  OpDescriptor,
  TrajectorySummary,
} from '../types.js';

export interface OpBranchHandle {
  /** Stable id for the op branch (jj bookmark/branch name). */
  readonly id: string;
  readonly name: string;
  /** Active trajectory id, if a learning trajectory was opened at spawn. */
  trajectoryId?: string;
}

/** The CODE/OP branch plane (agentic-jujutsu). */
export interface OpBranchProvider {
  /** Whether the underlying augmentation is live. */
  readonly available: boolean;
  /** Create a jj branch for an agent and open a learning trajectory. */
  spawn(agentId: string): Promise<OpBranchHandle>;
  /** Fold the current op(s) into the active trajectory. */
  recordOp(handle: OpBranchHandle): Promise<void>;
  /** Finalize the trajectory with a reward score. */
  finalize(handle: OpBranchHandle, successScore: number, critique?: string): Promise<TrajectorySummary>;
  /** The op-sequence produced on this branch (newest-last). */
  opSequence(handle: OpBranchHandle): Promise<OpDescriptor[]>;
  /** Roll back the op-log (jj undo). */
  undo(handle: OpBranchHandle): Promise<void>;
  /** Merge/squash this branch's ops into the base. */
  merge(handle: OpBranchHandle): Promise<void>;
}

export interface MemoryBranchHandle {
  readonly id: string;
  readonly label: string;
}

/** The MEMORY branch plane (agenticow COW vector branch). */
export interface MemoryBranchProvider {
  readonly available: boolean;
  /** Create a COW branch off the base memory (~O(1) in base size). */
  branch(label: string): Promise<MemoryBranchHandle>;
  /** Ingest embedded records into the branch's working node. */
  ingest(handle: MemoryBranchHandle, records: MemoryRecord[]): Promise<{ accepted: number }>;
  /** Freeze a restore point. */
  checkpoint(handle: MemoryBranchHandle, label?: string): Promise<{ id: string }>;
  /** Drop the branch delta back to a checkpoint (or its base). */
  rollback(handle: MemoryBranchHandle, checkpointId?: string): Promise<void>;
  /** Promote the branch's winning delta into the base memory. */
  promote(handle: MemoryBranchHandle): Promise<{ ingested: number; deleted: number }>;
  /** Git-style diff of the branch vs its ancestor. */
  diff(handle: MemoryBranchHandle): Promise<MemoryDelta>;
}

/**
 * The cross-branch memory QUERY plane. STUBBED interface: native ANN spanning
 * the COW boundary (RuVector PR #617) is pending. A default impl backed by
 * agenticow's exact read-through query() can be supplied; until the native
 * index ships, treat results as exact-but-unaccelerated.
 */
export interface MemoryQueryProvider {
  readonly nativeAnn: boolean;
  queryAcrossBranches(
    handle: MemoryBranchHandle,
    vector: Float32Array | number[],
    k?: number,
  ): Promise<MemoryQueryHit[]>;
}
