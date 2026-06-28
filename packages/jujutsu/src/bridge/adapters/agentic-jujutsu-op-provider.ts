// SPDX-License-Identifier: MIT
//
// Real OpBranchProvider backed by agentic-jujutsu's JjWrapper.
//
// WIRED: trajectory open/finalize, op-sequence read, registerAgent (lock-free
// QuantumDAG coordination), and branch lifecycle.
// RUNTIME PREREQ: branch / undo / merge / op reads shell out to the `jj` CLI.
// If jj is absent these throw at call time (not at construction) — the
// trajectory + coordination calls still work. `available` reflects only whether
// the native addon loaded; use probe() for the jj-CLI check.
//
// UPSTREAM BUG WORKAROUND (agentic-jujutsu ≤2.3.6): JjWrapper.branchCreate()
// shells `jj branch create`, but jj ≥0.21 renamed that subcommand to
// `jj bookmark`. Against modern jj (the bundle ships 0.35.0) branchCreate throws
// "unrecognized subcommand 'branch'". We therefore drive branching through
// execute(['bookmark', ...]) and only fall back to branchCreate() for old jj.
// See ADR-202 §"Upstream bug" and the jj-source-review for the upstream fix.

import { JujutsuCapability, jujutsuAvailable } from '../../capability.js';
import type { OpDescriptor, TrajectorySummary } from '../../types.js';
import type { OpBranchHandle, OpBranchProvider } from '../ports.js';

export interface AgenticJujutsuOpOptions {
  /** jj branch revision to base new branches on. Default: '@' (working copy). */
  baseRevision?: string;
  /** Agent type string for QuantumDAG registration. Default: 'coder'. */
  agentType?: string;
  /** Enable QuantumDAG coordination at first spawn. Default: true. */
  coordinate?: boolean;
}

export class AgenticJujutsuOpProvider implements OpBranchProvider {
  readonly available: boolean;
  private readonly cap: JujutsuCapability | null;
  private coordinated = false;

  constructor(private readonly opts: AgenticJujutsuOpOptions = {}) {
    this.available = jujutsuAvailable();
    this.cap = this.available ? JujutsuCapability.create() : null;
  }

  async spawn(agentId: string): Promise<OpBranchHandle> {
    const cap = this.must();
    if ((this.opts.coordinate ?? true) && !this.coordinated) {
      await cap.enableCoordination();
      this.coordinated = true;
    }
    await cap.registerAgent(agentId, this.opts.agentType ?? 'coder');
    const name = `agent/${agentId}`;
    await this.createBranch(cap, name);
    const trajectoryId = cap.startTrajectory(`agent:${agentId}`);
    return { id: name, name, trajectoryId };
  }

  async recordOp(_handle: OpBranchHandle): Promise<void> {
    this.must().addToTrajectory();
  }

  async finalize(handle: OpBranchHandle, successScore: number, critique?: string): Promise<TrajectorySummary> {
    const summary = this.must().finalizeTrajectory(successScore, critique);
    return { ...summary, trajectoryId: summary.trajectoryId || (handle.trajectoryId ?? '') };
  }

  async opSequence(_handle: OpBranchHandle): Promise<OpDescriptor[]> {
    return this.must().userOps(1000);
  }

  async undo(_handle: OpBranchHandle): Promise<void> {
    await this.must().raw.undo();
  }

  async merge(handle: OpBranchHandle): Promise<void> {
    // Squash this branch's revision into its parent — jj's merge/promote
    // primitive — then drop the now-redundant bookmark.
    const cap = this.must();
    await cap.raw.execute(['squash', '--from', handle.name]);
    try {
      await cap.raw.execute(['bookmark', 'delete', handle.name]);
    } catch {
      /* old jj: bookmark may not exist / different surface — non-fatal */
    }
  }

  /**
   * Create the agent branch as a jj bookmark, working around the agentic-jujutsu
   * `jj branch` bug on modern jj. Falls back to the native branchCreate() for
   * jj versions that still expose `jj branch`.
   */
  private async createBranch(cap: JujutsuCapability, name: string): Promise<void> {
    const rev = this.opts.baseRevision ?? '@';
    try {
      await cap.raw.execute(['bookmark', 'create', '-r', rev, name]);
    } catch (bookmarkErr) {
      try {
        await cap.raw.branchCreate(name, this.opts.baseRevision ?? null);
      } catch {
        throw bookmarkErr; // surface the modern-jj error, which is the common case
      }
    }
  }

  private must(): JujutsuCapability {
    if (!this.cap) throw new Error('AgenticJujutsuOpProvider: agentic-jujutsu unavailable');
    return this.cap;
  }
}
