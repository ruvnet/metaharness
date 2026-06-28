// SPDX-License-Identifier: MIT
//
// @metaharness/jujutsu — lock-free version-control-for-agents as a MetaHarness
// capability, plus the agenticow dual-state bridge.
//
// agentic-jujutsu and agenticow are OPTIONAL peers (ADR-150 principle: removable
// augmentation, never a required runtime dep). Everything here imports and
// type-checks with neither installed; `probe()` reports what is actually live.

// Capability facade over agentic-jujutsu.
export { JujutsuCapability, probe, jujutsuAvailable, quantumSigner } from './capability.js';

// Embedder (op-sequence -> vector) — swap HashEmbedder for a real model.
export { HashEmbedder } from './embed.js';
export type { Embedder } from './embed.js';

// Types.
export {
  CapabilityUnavailableError,
} from './types.js';
export type {
  CapabilityReport,
  JujutsuConfig,
  OpDescriptor,
  TrajectorySummary,
  MemoryRecord,
  MemoryDelta,
  MemoryQueryHit,
} from './types.js';

// The dual-state bridge (also available at the ./bridge subpath export).
export {
  DualStateBridge,
  MockOpProvider,
  MockMemoryProvider,
  MockQueryProvider,
  AgenticJujutsuOpProvider,
  AgenticowMemoryProvider,
  AgenticowQueryProvider,
} from './bridge/index.js';
export type {
  DualBranch,
  LearnResult,
  BridgeOptions,
  OpBranchProvider,
  OpBranchHandle,
  MemoryBranchProvider,
  MemoryBranchHandle,
  MemoryQueryProvider,
  AgenticJujutsuOpOptions,
  AgenticowOptions,
} from './bridge/index.js';
