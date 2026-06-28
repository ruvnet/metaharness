// SPDX-License-Identifier: MIT
//
// @metaharness/jujutsu — structural types.
//
// These mirror the public surface of `agentic-jujutsu` (v2.3.6) WITHOUT taking a
// hard dependency on it. agentic-jujutsu is an OPTIONAL peer (ADR-150 principle:
// removable augmentation, never a required runtime dep), so this package must
// type-check and import even when the native addon is absent. We declare the
// minimal structural shapes we consume and cast at the dynamic-import boundary.

/** Subset of agentic-jujutsu's JjConfig we expose. */
export interface JujutsuConfig {
  jjPath?: string;
  repoPath?: string;
  timeoutMs?: number;
  verbose?: boolean;
  maxLogEntries?: number;
  enableAgentdbSync?: boolean;
}

/** A single entry in the jj operation log (subset of agentic-jujutsu's JjOperation). */
export interface OpDescriptor {
  id: string;
  operationId: string;
  operationType: string;
  command: string;
  user: string;
  timestamp: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Result of finalizing a learning trajectory. */
export interface TrajectorySummary {
  trajectoryId: string;
  successScore: number;
  critique?: string;
  opCount: number;
}

/** A vector record ingested into a memory branch. */
export interface MemoryRecord {
  id: number;
  vector: Float32Array | number[];
}

/** Delta of a memory branch vs its nearest ancestor (mirrors agenticow MemoryDiff). */
export interface MemoryDelta {
  added: number[];
  overridden: number[];
  deleted: number[];
}

/** A k-NN hit from the (stubbed) cross-branch memory query. */
export interface MemoryQueryHit {
  id: number;
  distance: number;
  branch: string;
}

/** Honest capability probe result — mirrors the kernel's capability reporting. */
export interface CapabilityReport {
  /** agentic-jujutsu native addon loadable? */
  opLog: boolean;
  /** agenticow COW memory branching loadable? */
  memory: boolean;
  /** jj (Jujutsu) CLI resolvable on PATH or at the configured path? */
  jjCli: boolean;
  /** cross-branch ANN search (agenticow native, RuVector PR #617) shipped? */
  annAcrossBranch: boolean;
  notes: string[];
}

/** Thrown when a removable augmentation is required but not installed. */
export class CapabilityUnavailableError extends Error {
  constructor(
    public readonly capability: string,
    public readonly cause?: unknown,
  ) {
    super(
      `@metaharness/jujutsu: capability "${capability}" is unavailable. ` +
        `It is a removable augmentation (ADR-150) — install the optional peer ` +
        `dependency and any system prerequisites to enable it.` +
        (cause instanceof Error ? ` Underlying: ${cause.message}` : ''),
    );
    this.name = 'CapabilityUnavailableError';
  }
}
