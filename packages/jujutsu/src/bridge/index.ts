// SPDX-License-Identifier: MIT
//
// @metaharness/jujutsu/bridge — the agenticow <-> agentic-jujutsu dual-state
// bridge (ADR-202). Public surface.

export { DualStateBridge } from './bridge.js';
export type { DualBranch, LearnResult, BridgeOptions } from './bridge.js';

export type {
  OpBranchProvider,
  OpBranchHandle,
  MemoryBranchProvider,
  MemoryBranchHandle,
  MemoryQueryProvider,
} from './ports.js';

// Adapters
export { MockOpProvider, MockMemoryProvider, MockQueryProvider } from './adapters/mock-providers.js';
export { AgenticJujutsuOpProvider } from './adapters/agentic-jujutsu-op-provider.js';
export type { AgenticJujutsuOpOptions } from './adapters/agentic-jujutsu-op-provider.js';
export {
  AgenticowMemoryProvider,
  AgenticowQueryProvider,
} from './adapters/agenticow-memory-provider.js';
export type { AgenticowOptions } from './adapters/agenticow-memory-provider.js';
