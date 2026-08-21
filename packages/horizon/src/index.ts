// @metaharness/horizon — the portable, deterministic core of Google ADK's
// long-horizon-harness, re-implemented as Rust/WASM + TypeScript.
//
// Three cloned primitives, no cloud and no live-model dependency:
//   - HaltController  — ADK `halt_reason`: iteration-budget / no-progress /
//                       repeated-failure halts, armed on observe, consumed at
//                       before_model, reset at turn boundaries. State is
//                       serializable → sessions resume.
//   - CommandGuard    — ADK `command_classify`: classify the WHOLE shell
//                       command (every segment + substitution) so a gated op
//                       cannot be smuggled behind a benign one. Rust/WASM.
//   - CompactionPolicy — ADK context compaction with the flush-durable-facts-
//                       BEFORE-lossy-summary ordering as an enforced invariant.
//   - LongHorizonDriver — the three, composed into a resumable turn loop.
export { HorizonCore } from './core.js';

export {
  HaltController,
  DEFAULT_HALT_CONFIG,
} from './halt.js';
export type { HaltConfig, HaltState, HaltReason, HaltDecision } from './halt.js';

export { CommandGuard } from './guard.js';
export type {
  Verdict,
  CommandPolicy,
  SegmentVerdict,
  Classification,
} from './guard.js';

export {
  CompactionPolicy,
  DEFAULT_COMPACTION_CONFIG,
} from './compaction.js';
export type {
  CompactionConfig,
  CompactionSeams,
  CompactionResult,
} from './compaction.js';

export { LongHorizonDriver } from './driver.js';
export type {
  HorizonEvent,
  StepResult,
  DriverSeams,
  DriverConfig,
  TurnOutcome,
} from './driver.js';

export { NodeToolExecutor, UnavailableToolExecutor, digestWorkspace } from './executor.js';
export type {
  ToolExecutor,
  ToolExecutionRequest,
  ToolExecutionResult,
  PolicyReceipt,
  NodeToolExecutorOptions,
} from './executor.js';
export { hashCheckpoint, verifyCheckpoint } from './checkpoint.js';
export type { HorizonCheckpoint, HorizonContinuity } from './checkpoint.js';
