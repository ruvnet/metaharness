// @metaharness/oo-agents — a Rust/WASM + TypeScript clone of NOOA
// (NVIDIA-NeMo/labs-OO-Agents): the agent is a class; the model acts by
// writing code in a fuel-limited wasm sandbox. See ADR-242.
export { Agent, agentic, Runtime } from './agent.js';
export type {
  AgenticSpec,
  AgenticContext,
  CellRecord,
  DriverStep,
  ModelDriver,
  AgentEvent,
} from './agent.js';
export { ScriptedDriver, renderContext } from './driver.js';
export { LlmDriver, MockCompletion, extractCode, CELL_INSTRUCTION } from './llm-driver.js';
export type { CompletionFn, LlmDriverOptions } from './llm-driver.js';
export { CellVm } from './vm.js';
export type { CellOutcome, HostBinding } from './vm.js';
export { validate, describe } from './schema.js';
export type { Schema } from './schema.js';

// ADR-241/ADR-242 composition: an OO agent AS a radio PodAgent, so a POD of OO
// agents coordinates over the @metaharness/radio passive-awareness bus.
export {
  PodMemberAgent,
  SequentialPodDriver,
  asPodAgent,
  buildPod,
  makePodTask,
  runPod,
  runPodExample,
} from './pod.js';
export type {
  PodTask,
  PodMemberConfig,
  PodDriver,
  BuildPodOptions,
  RunPodOptions,
  PodRun,
} from './pod.js';
