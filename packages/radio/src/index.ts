// @metaharness/radio — passive-awareness swarm bus (AgentRadio, arXiv:2607.28430).
export { RadioBus } from './bus.js';
export type { RadioMessage, ThreadInfo } from './bus.js';
export { Watcher } from './watcher.js';
export type { FoldedMention } from './watcher.js';
export { runProtocol } from './protocol.js';
export type { PodAgent, ProtocolConfig, ProtocolResult, PhaseName } from './protocol.js';
export { runSim, makeTask } from './sim.js';
export type { SimConfig, SimResult, SimMode, SimTask } from './sim.js';
