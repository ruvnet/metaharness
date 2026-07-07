// SPDX-License-Identifier: MIT
//
// @metaharness/workspace-lens — a Jacobian-Lens interpretability primitive for open-weight LLMs.
// Runtime-only (fitting is external), model-agnostic, dependency-free. See README.md.

export * from './types.js';
export * from './linalg.js';
export { WorkspaceLens } from './lens.js';
export { detectConcepts, flagsFromTriggers, hasCriticalTrigger, FLAG_CONCEPTS, type DetectOptions } from './safety.js';
export { workspaceDrift, entropyTrajectory } from './drift.js';
export { decide } from './decision.js';
export { buildReceipt, sha256, type BuildReceiptOptions } from './receipt.js';
